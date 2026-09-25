import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConnectorError,
  SyntheticToneConnector
} from '../../../connectors/examples/synthetic-tone/connector.ts'
import {
  audioFrameToJson,
  currentProtocol,
  parseAudioFrame,
  parseRuntimeEvent,
  parseSessionControl,
  parseVoiceSource,
  runtimeEventToJson,
  voiceSourceToJson,
  type AudioFrame,
  type RuntimeEvent,
  type SessionControl
} from '../src/index.ts'

// Deterministic host clock: 1000 us per reading.
function fakeClock (): () => bigint {
  let now = 0n
  return () => {
    now += 1000n
    return now
  }
}

let requestSequence = 0
function command (sessionId: string, json: Record<string, unknown>): SessionControl {
  requestSequence += 1
  return parseSessionControl({ protocol: currentProtocol, sessionId, requestSequence: String(requestSequence), ...json })
}

function states (events: RuntimeEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'sessionStateChanged')
    .map((event) => String(event.payload.current))
}

// Everything a connector emits must survive the SDK's own parser: that is what murmur.v1 conformance means here.
function assertWireValid (events: RuntimeEvent[], frames: AudioFrame[]): void {
  for (const event of events) assert.deepEqual(parseRuntimeEvent(runtimeEventToJson(event)), event)
  for (const frame of frames) assert.deepEqual(parseAudioFrame(audioFrameToJson(frame)), frame)
}

function started (connector = new SyntheticToneConnector({ clockUs: fakeClock() }), sessionId = 'session-a') {
  const source = connector.discover()[0]
  connector.connect(source.sourceId)
  const events = connector.control(command(sessionId, { start: { source: voiceSourceToJson(source) } }))
  return { connector, events }
}

test('discovery returns a wire-valid synthetic source and is repeatable', () => {
  const connector = new SyntheticToneConnector()
  const sources = connector.discover()
  assert.equal(sources.length, 1)
  assert.deepEqual(parseVoiceSource(voiceSourceToJson(sources[0])), sources[0])
  assert.equal(sources[0].transport, 'SOURCE_TRANSPORT_SYNTHETIC')
  assert.deepEqual(connector.discover(), sources)
})

test('start reports STARTING, readiness, then LISTENING with increasing sequences', () => {
  const { events } = started()
  assert.deepEqual(states(events), ['SESSION_STATE_STARTING', 'SESSION_STATE_LISTENING'])
  assert.deepEqual(events.map((event) => event.kind), ['sessionStateChanged', 'captureReadiness', 'sessionStateChanged'])
  assert.deepEqual(events.map((event) => event.sequence), [1n, 2n, 3n])
  assertWireValid(events, [])
})

test('frames are deterministic PCM with sample-clock timestamps and strictly increasing sequences', () => {
  const first = started().connector
  const second = started().connector
  const frames = [first.nextFrame(), first.nextFrame(), first.nextFrame()] as AudioFrame[]
  assert.deepEqual([second.nextFrame(), second.nextFrame(), second.nextFrame()], frames)
  assert.deepEqual(frames.map((frame) => frame.sequence), [1n, 2n, 3n])
  // 20 ms frames: timestamps advance by exactly 20000 us from the session start.
  const start = frames[0].monotonicTimeUs
  assert.deepEqual(frames.map((frame) => frame.monotonicTimeUs - start), [0n, 20000n, 40000n])
  // 16 kHz mono s16le, 20 ms: 320 samples, 640 bytes.
  assert.equal(Buffer.from(frames[0].payloadBase64, 'base64').length, 640)
  assertWireValid([], frames)
})

test('closing the input gate mutes capture without ending the session', () => {
  const { connector } = started()
  const muted = connector.control(command('session-a', { inputGate: { open: false } }))
  assert.deepEqual(states(muted), ['SESSION_STATE_WARM_MUTED'])
  assert.equal(connector.nextFrame(), undefined)
  const resumed = connector.control(command('session-a', { inputGate: { open: true } }))
  assert.deepEqual(states(resumed), ['SESSION_STATE_LISTENING'])
  assert.equal(connector.nextFrame()?.sequence, 1n)
  assert.deepEqual(connector.control(command('session-a', { inputGate: { open: true } })), [])
})

test('finalize stops new audio, and stop ends the session', () => {
  const { connector } = started()
  connector.nextFrame()
  assert.deepEqual(states(connector.control(command('session-a', { finalize: {} }))), ['SESSION_STATE_FINALIZING'])
  assert.equal(connector.nextFrame(), undefined)
  assert.deepEqual(connector.control(command('session-a', { finalize: {} })), [])
  assert.deepEqual(states(connector.control(command('session-a', { stop: { reason: 'done' } }))), ['SESSION_STATE_STOPPED'])
})

test('stop mid-capture cancels further frames and repeated stop is a no-op', () => {
  const { connector } = started()
  connector.nextFrame()
  const stopped = connector.control(command('session-a', { stop: {} }))
  assert.deepEqual(states(stopped), ['SESSION_STATE_STOPPED'])
  assert.equal(connector.nextFrame(), undefined)
  assert.deepEqual(connector.control(command('session-a', { stop: {} })), [])
  assertWireValid(stopped, [])
})

test('disconnect cleans up an active session and is safe to repeat', () => {
  const { connector } = started()
  assert.deepEqual(states(connector.disconnect()), ['SESSION_STATE_STOPPED'])
  assert.deepEqual(connector.disconnect(), [])
  assert.equal(connector.nextFrame(), undefined)
  assert.throws(
    () => connector.control(command('session-b', { start: {} })),
    (error: unknown) => error instanceof ConnectorError && error.code === 'not-connected'
  )
})

test('a new session restarts sequences after the previous one stops', () => {
  const { connector } = started()
  connector.nextFrame()
  connector.control(command('session-a', { stop: {} }))
  const events = connector.control(command('session-b', { start: {} }))
  assert.equal(events[0].sequence, 1n)
  assert.equal(connector.nextFrame()?.sequence, 1n)
})

test('failures use stable codes and never start a session', () => {
  const connector = new SyntheticToneConnector()
  const code = (expected: string) => (error: unknown) => error instanceof ConnectorError && error.code === expected
  assert.throws(() => connector.connect('source-missing'), code('source-not-found'))
  assert.throws(() => connector.control(command('session-a', { start: {} })), code('not-connected'))
  connector.connect('source-synthetic-tone')
  const wrongFormat = { requestedFormat: { sampleRateHz: 48000, channels: 1, encoding: 'AUDIO_ENCODING_PCM_S16LE' } }
  assert.throws(() => connector.control(command('session-a', { start: wrongFormat })), code('unsupported-format'))
  assert.equal(connector.nextFrame(), undefined)
  connector.control(command('session-a', { start: {} }))
  assert.throws(() => connector.control(command('session-b', { start: {} })), code('session-already-active'))
  assert.throws(() => connector.control(command('session-b', { finalize: {} })), code('unknown-session'))
})
