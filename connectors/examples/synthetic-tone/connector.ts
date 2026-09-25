// A minimal, deterministic example connector for the connector authoring guide.
//
// It works at the murmur.v1 message level: the host hands it SessionControl
// messages and pulls AudioFrame and RuntimeEvent messages from it. It is a
// teaching example, not a runtime interface proposal, and it produces only a
// synthetic sine tone, so it needs no permissions, hardware, or real audio.

import {
  currentProtocol,
  type AudioFrame,
  type RuntimeEvent,
  type SessionControl,
  type VoiceSource
} from '../../../sdks/typescript/src/index.ts'

type SessionState = 'SESSION_STATE_IDLE' | 'SESSION_STATE_STARTING' | 'SESSION_STATE_LISTENING' |
  'SESSION_STATE_WARM_MUTED' | 'SESSION_STATE_FINALIZING' | 'SESSION_STATE_STOPPED'

// Mirrors murmur.v1 MurmurError: a stable code for programs, a display-safe message for people.
export class ConnectorError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor (code: string, message: string, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

export interface SyntheticToneOptions {
  sampleRateHz?: number
  frameDurationMs?: number
  frequencyHz?: number
  // Host monotonic clock in microseconds, used for state events. Injected so tests are deterministic.
  clockUs?: () => bigint
}

interface ActiveSession {
  id: string
  state: SessionState
  eventSequence: bigint
  frameSequence: bigint
  samplesEmitted: number
  startedAtUs: bigint
}

const SOURCE: VoiceSource = {
  sourceId: 'source-synthetic-tone',
  displayName: 'Synthetic tone',
  transport: 'SOURCE_TRANSPORT_SYNTHETIC',
  capabilities: ['SOURCE_CAPABILITY_LIVE_AUDIO', 'SOURCE_CAPABILITY_INPUT_MUTE'],
  metadata: { generator: 'sine' }
}

const AMPLITUDE = 0.25
const INT16_MAX = 32767

export class SyntheticToneConnector {
  readonly sampleRateHz: number
  readonly frameDurationMs: number
  readonly frequencyHz: number
  private readonly clockUs: () => bigint
  private connectedSourceId: string | undefined
  private session: ActiveSession | undefined

  constructor (options: SyntheticToneOptions = {}) {
    this.sampleRateHz = options.sampleRateHz ?? 16000
    this.frameDurationMs = options.frameDurationMs ?? 20
    this.frequencyHz = options.frequencyHz ?? 440
    this.clockUs = options.clockUs ?? (() => process.hrtime.bigint() / 1000n)
  }

  // Discovery is side-effect free and safe to repeat. A hardware connector would
  // report missing permissions here instead of prompting or throwing.
  discover (): VoiceSource[] {
    return [SOURCE]
  }

  connect (sourceId: string): void {
    if (sourceId !== SOURCE.sourceId) {
      throw new ConnectorError('source-not-found', `Unknown source: ${sourceId}`)
    }
    this.connectedSourceId = sourceId
  }

  // Applies one SessionControl and returns the events it caused, in order.
  control (command: SessionControl): RuntimeEvent[] {
    if (command.kind === 'start') return this.start(command)
    const session = this.session
    if (session === undefined || session.id !== command.sessionId) {
      // Stop is idempotent: stopping a session that already ended is not an error.
      if (command.kind === 'stop') return []
      throw new ConnectorError('unknown-session', `No active session ${command.sessionId}`)
    }
    if (command.kind === 'stop') return this.end(session)
    if (command.kind === 'finalize') {
      return session.state === 'SESSION_STATE_FINALIZING' ? [] : [this.transition(session, 'SESSION_STATE_FINALIZING')]
    }
    // inputGate: closing mutes capture without ending the session; opening resumes it.
    const open = command.body.open === true
    if (open && session.state === 'SESSION_STATE_WARM_MUTED') return [this.transition(session, 'SESSION_STATE_LISTENING')]
    if (!open && session.state === 'SESSION_STATE_LISTENING') return [this.transition(session, 'SESSION_STATE_WARM_MUTED')]
    return []
  }

  // Pull-based capture: the host asks for the next frame when it can accept one,
  // so the connector never queues audio the host has not consumed.
  nextFrame (): AudioFrame | undefined {
    const session = this.session
    if (session === undefined || session.state !== 'SESSION_STATE_LISTENING') return undefined
    const samplesPerFrame = Math.round((this.sampleRateHz * this.frameDurationMs) / 1000)
    const payload = Buffer.alloc(samplesPerFrame * 2)
    for (let index = 0; index < samplesPerFrame; index += 1) {
      const t = (session.samplesEmitted + index) / this.sampleRateHz
      const sample = Math.round(Math.sin(2 * Math.PI * this.frequencyHz * t) * AMPLITUDE * INT16_MAX)
      payload.writeInt16LE(sample, index * 2)
    }
    // Frame time comes from the sample count, so it cannot drift from the audio itself.
    const monotonicTimeUs = session.startedAtUs +
      BigInt(Math.round((session.samplesEmitted * 1_000_000) / this.sampleRateHz))
    session.samplesEmitted += samplesPerFrame
    session.frameSequence += 1n
    return {
      protocol: currentProtocol,
      sessionId: session.id,
      sequence: session.frameSequence,
      monotonicTimeUs,
      format: {
        sampleRateHz: this.sampleRateHz,
        channels: 1,
        encoding: 'AUDIO_ENCODING_PCM_S16LE',
        frameDurationMs: this.frameDurationMs
      },
      payloadBase64: payload.toString('base64')
    }
  }

  // Releases everything. Safe to call at any time, including twice.
  disconnect (): RuntimeEvent[] {
    const events = this.session === undefined ? [] : this.end(this.session)
    this.connectedSourceId = undefined
    return events
  }

  private start (command: SessionControl): RuntimeEvent[] {
    if (this.connectedSourceId === undefined) {
      throw new ConnectorError('not-connected', 'Connect to a source before starting a session')
    }
    if (this.session !== undefined) {
      throw new ConnectorError('session-already-active', `Session ${this.session.id} is still active`)
    }
    const requested = command.body.requestedFormat as Record<string, unknown> | undefined
    if (requested !== undefined && (
      requested.encoding !== 'AUDIO_ENCODING_PCM_S16LE' ||
      requested.channels !== 1 ||
      requested.sampleRateHz !== this.sampleRateHz
    )) {
      // Refuse rather than silently producing a different format than the host asked for.
      throw new ConnectorError('unsupported-format', 'Only mono PCM_S16LE at the configured sample rate is supported')
    }
    const session: ActiveSession = {
      id: command.sessionId,
      state: 'SESSION_STATE_IDLE',
      eventSequence: 0n,
      frameSequence: 0n,
      samplesEmitted: 0,
      startedAtUs: this.clockUs()
    }
    this.session = session
    return [
      this.transition(session, 'SESSION_STATE_STARTING'),
      this.event(session, 'captureReadiness', { live: true }),
      this.transition(session, 'SESSION_STATE_LISTENING')
    ]
  }

  private end (session: ActiveSession): RuntimeEvent[] {
    this.session = undefined
    return [this.transition(session, 'SESSION_STATE_STOPPED')]
  }

  private transition (session: ActiveSession, next: SessionState): RuntimeEvent {
    const previous = session.state
    session.state = next
    return this.event(session, 'sessionStateChanged', { previous, current: next })
  }

  private event (
    session: ActiveSession,
    kind: RuntimeEvent['kind'],
    payload: Record<string, unknown>
  ): RuntimeEvent {
    session.eventSequence += 1n
    return {
      protocol: currentProtocol,
      sessionId: session.id,
      sequence: session.eventSequence,
      monotonicTimeUs: this.clockUs(),
      kind,
      payload
    }
  }
}
