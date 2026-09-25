# Connector authoring guide

A connector adapts one family of voice sources to the `murmur.v1` protocol: an
Omi wearable, a phone microphone, a headset, a network stream. This guide
explains what a connector must do, how it should behave at the edges, and how
to show a reviewer that it works. It applies to connectors written in any
language, in-process or as a sidecar.

Read [architecture.md](architecture.md) first for where connectors sit. The
[connector checklist in CONTRIBUTING.md](../CONTRIBUTING.md#connector-pull-requests)
lists what a connector pull request must document; this guide explains the
expected behavior behind each item.

The worked example is [`connectors/examples/synthetic-tone`](../connectors/examples/synthetic-tone).
It is a complete, tested TypeScript connector for a synthetic sine-wave source,
small enough to read in one sitting.

## What a connector owns

| Owns | Does not own |
| --- | --- |
| Discovering sources and reporting them as `VoiceSource` | Choosing a transcription or language provider |
| Reporting permission and readiness state | Storing recordings, transcripts, or history |
| Connect, start, mute, finalize, stop, disconnect, cleanup | Interpreting what the user said |
| Parsing the source's codec and framing into `AudioFrame` | Product UI, prompts, or settings screens |
| Declaring capabilities it actually implements | Retrying on behalf of the host indefinitely |
| Actionable errors with stable codes | Provider- or product-specific assumptions |

## The manifest

Every connector ships a `connector.json` validated by
[`spec/connector-manifest.schema.json`](../spec/connector-manifest.schema.json).
`make check-conformance` checks every `connectors/**/connector.json`: required
and unknown fields, the ID and version grammar, the protocol major, duplicate
list entries, that the implementation path exists, and that at least one license
is named.

State the real status. `experimental` is the right starting point, and it is
welcome. `supported` means the documented platforms have passed the automated
tests and the physical validation below. Capabilities list what works today, not
what is planned.

## Lifecycle

A source moves through discovery, connection, and one or more sessions. A
session is one explicit capture, driven by `SessionControl` commands and
reported with `RuntimeEvent`s.

```text
discover ──▶ connect ──▶ start ──▶ LISTENING ◀──▶ WARM_MUTED
                           │           │   (inputGate close/open)
                           │           ▼
                           │       FINALIZING ──▶ stop ──▶ STOPPED ──▶ disconnect
                           └──────────────────────────────────────────▶ (cleanup)
```

- **Discover** is side-effect free and safe to repeat. Do not prompt for
  permissions or open connections while enumerating.
- **Connect** acquires the source (for example, a BLE link). A failure is an
  error with a stable code, never a half-connected source.
- **Start** reports `SESSION_STATE_STARTING`, then `captureReadiness` with
  `live: true` once audio can actually flow, then `SESSION_STATE_LISTENING`.
  Only one session per connected source unless the source genuinely supports
  more.
- **Input gate** closing moves to `SESSION_STATE_WARM_MUTED`: capture stops, the
  session and the connection stay. Opening returns to `LISTENING`. Repeating the
  current gate state changes nothing. With `flushAcceptedAudio`, audio already
  handed to the host may still finalize.
- **Finalize** stops new audio (`SESSION_STATE_FINALIZING`) so downstream
  providers can finish; the session still needs `stop`.
- **Stop** ends the session with `SESSION_STATE_STOPPED`.
- **Disconnect** stops any active session first, then releases the source.

Every event carries a session-scoped `sequence` that starts at 1 for each new
session and strictly increases. Audio frames keep their own sequence, with the
same rules.

## Capabilities

`VoiceSource.capabilities` tells the host what it may ask for. Declare a
capability only when it works end to end on the documented platforms:

- `SOURCE_CAPABILITY_LIVE_AUDIO`: streaming capture during a session.
- `SOURCE_CAPABILITY_INPUT_MUTE`: the input gate works without tearing down the session.
- `SOURCE_CAPABILITY_STORED_AUDIO`, `BATTERY`, `HARDWARE_CONTROL`,
  `OUTPUT_AUDIO`, `BACKGROUND_CAPTURE`, `SPEAKER_VERIFICATION`: only with
  documented behavior and tests.

When the host asks for something undeclared, return an error with a stable code
such as `unsupported-capability`. Do not silently ignore the request.

## Discovery and permissions

- Report missing permissions (microphone, Bluetooth, local network) as state the
  host can act on. The host, not the connector, decides when to prompt.
- Keep `VoiceSource.metadata` non-sensitive. Raw device identifiers such as MAC
  addresses or serial numbers, credentials, signed URLs, and user speech are
  forbidden. Use a stable, locally derived `sourceId` instead of a hardware
  address.
- A source that disappears during discovery simply stops being listed. A source
  that disappears during a session is an interruption (below).

## Audio format and framing

- Every `AudioFrame.format` states `sampleRateHz`, `channels`, `encoding`, and
  `frameDurationMs`. Keep the format constant within a session.
- If the host requests a format the source cannot produce, refuse with an error
  such as `unsupported-format`. Do not silently deliver something else.
  Resampling belongs in a clearly documented processing step, not hidden inside
  the transport.
- For PCM, the payload length must match the format:
  `sampleRateHz × channels × bytesPerSample × frameDurationMs / 1000`. The
  conformance fixtures check this.
- Decode source codecs (for example Opus or a vendor framing) inside the
  connector, and cite the protocol source you followed (see provenance below).

## Timestamps and ordering

- `monotonic_time_us` comes from the producing host's monotonic clock. It is only
  comparable within one session on one machine. Never use wall-clock time.
- Derive audio frame timestamps from the sample count since the session started,
  not from when a packet arrived. Transport jitter then cannot make audio appear
  to speed up or slow down. The example computes
  `start + samplesEmitted × 1e6 / sampleRate`.
- Ordering uses `sequence`, never timestamps.

## Backpressure

A connector must not buffer audio without limit when the host falls behind.

- **Prefer pull.** Produce a frame when the host asks for one. The example's
  `nextFrame()` does this, so nothing can queue up.
- If the transport pushes (BLE notifications, sockets), use a **bounded** queue.
  When it is full, drop the oldest frames, keep sequences increasing so the gap
  is visible, and report an error event with a code such as `audio-dropped` and
  `retryable: true`.
- Never block the transport's callback thread on a slow consumer.

## Interruption, cancellation, and cleanup

- **Stop and disconnect are idempotent.** Calling them twice, or after the
  source vanished, is not an error.
- **Cancellation during startup.** A `stop` that arrives while starting must end
  in `STOPPED` without later emitting `LISTENING` or frames.
- **Source loss mid-session.** Emit an error event (`source-lost`, with
  `retryable` set honestly), then `SESSION_STATE_STOPPED`, then release
  resources. Do not reconnect in a tight loop. Reconnection is either
  host-driven or bounded with backoff, and documented.
- **After stop, nothing more.** No frames or events for a stopped session,
  including late packets still in flight from the transport.
- **Release everything** on disconnect: sockets, BLE subscriptions, audio
  sessions, timers, and file handles. A leaked subscription after disconnect is
  a bug.

## Errors

Use the `MurmurError` shape: a stable, machine-readable `code`, a
`message` that is safe to show but not stable API, and `retryable`. Messages
must not contain speech, credentials, audio, or raw device identifiers. Document
every code your connector can produce.

## Testing

### Automated tests (required)

Build a fake or fixture for the transport so every test runs without hardware,
as the example does. Cover at least:

- discovery output parses as a valid `VoiceSource`;
- start → `STARTING`, readiness, `LISTENING`, with increasing sequences;
- frames: correct format, payload length, sample-derived timestamps, and
  increasing sequences, deterministic for the same input;
- input gate mute and resume;
- finalize, stop, repeated stop, and disconnect with an active session;
- cancellation during startup and source loss mid-session;
- every error code;
- every emitted `RuntimeEvent` and `AudioFrame` round-trips through your SDK's
  parser. This is the cheapest proof that you emit valid `murmur.v1`.

Use synthetic audio (tones, silence, generated noise). Never commit recordings,
transcripts, or real device identifiers.

### Conformance

- `make check-conformance` validates the shared fixtures and every connector
  manifest.
- Run your SDK's surface (`make check-typescript`, `check-dart`, and so on).
- If your connector exposes new observable protocol behavior, add fixtures under
  `conformance/fixtures` and register them in `conformance/manifest.json`.

### Physical validation (required before `supported`)

Record, for each platform and device model you claim:

1. device model, firmware, OS and version, host app build;
2. discover, connect, start, 60 seconds of capture, mute and resume, stop, disconnect;
3. source removed or powered off mid-session: the observed error and cleanup;
4. app backgrounded and restored, if background capture is claimed;
5. audio sanity: format, frame cadence, and absence of gaps, checked on a
   synthetic or consented test signal;
6. anything that failed or was not tested.

Put the results in the pull request. Untested platforms stay out of `platforms`.

## Provenance and license checklist

Before opening a pull request, confirm:

- [ ] Every protocol detail (service UUIDs, packet layouts, codecs) cites its
      source: official documentation, an open-source implementation, or your
      own observation of hardware you own.
- [ ] Adapted code keeps its copyright and license notice, and the license is
      compatible with Apache-2.0. Record it under `licenses` in
      `connector.json` (for example `"protocolReference": "MIT"`) and in
      `THIRD_PARTY_NOTICES.md` if code was adapted.
- [ ] No code or constants come from proprietary SDKs, decompiled apps, or
      sources whose terms forbid reuse.
- [ ] Bundled codec or model weights have a license that permits redistribution.
- [ ] No credentials, device identifiers, recordings, or private endpoints are
      committed, including in tests and fixtures.

## Proposing a connector

Open a [connector proposal](../.github/ISSUE_TEMPLATE/connector-proposal.yml)
before writing a new connector family. It asks for the source and platforms,
implementation language, protocol sources, hardware access, and privacy
implications, so the direction can be agreed on before the work starts.

## The example connector

[`connectors/examples/synthetic-tone`](../connectors/examples/synthetic-tone)
shows the rules above in about 200 lines:

- `connector.json`: an honest `experimental` manifest checked by
  `make check-conformance`.
- `connector.ts`: accepts `SessionControl`, emits `RuntimeEvent` and
  `AudioFrame` with the TypeScript SDK models, and uses pull-based frames,
  sample-derived timestamps, idempotent stop and disconnect, and stable error
  codes.
- `sdks/typescript/test/synthetic-tone-connector.test.ts`: the parts of the test
  list above that apply to a synchronous synthetic source, run by
  `make check-typescript`, with every emitted message round-tripped through the
  SDK parser. Startup cancellation and source loss need an asynchronous
  transport, so a real connector adds them.

It works directly at the `murmur.v1` message level and is a teaching example,
not a proposed runtime interface. Shared connector interfaces are tracked in
[#34](https://github.com/october-dev/murmur/issues/34).
