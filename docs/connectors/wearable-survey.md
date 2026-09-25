# Voice wearable survey: choosing the next connector

Survey for [#13](https://github.com/october-dev/murmur/issues/13), checked on **2026-09-25**. It compares voice
wearables and open hardware as candidates for Murmur's next connector after Omi, and recommends one.

This is desk research from vendor pages, official SDK and protocol documentation, and repositories and their
`LICENSE` files. No hardware was bought or tested, and no closed protocol was examined. This market changes quickly:
three candidates lost new-sale availability within about nine months. Re-check any row before starting
implementation.

**Evidence labels**

- **D**: documented in a primary source (vendor site, official docs, SDK repository, or `LICENSE` file), linked in the
  row or the notes.
- **R**: reported by secondary sources (for example news coverage of an acquisition), not confirmed on a vendor page.
- **U**: not confirmed from a primary source during this survey. Treat it as an open question, not as a limitation or a
  capability.

## Summary

| Candidate | Buy new today | Transport | Third-party live audio | SDK / code license | Vendor account needed | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Omi (baseline) | Yes (D) | BLE (D) | Yes: BLE audio service; Opus 16 kHz default, PCM and µ-law 8/16 kHz (D) | MIT (D) | U | Current connector |
| **Mentra Live / MentraOS** | Yes (D) | BLE and Wi-Fi (D) | Yes: `session.mic.onAudioChunk()`, base64 PCM or LC3 (D) | Apache-2.0 (D) | U (see risks) | **Recommended** |
| Brilliant Labs Halo | Yes (D) | BLE (D) | U: LE-Audio-style voice pipeline mentioned, no third-party stream documented | SDK BSD-3-Clause (D); firmware mixed, incl. restrictive Alif SDK license (D) | No, pairing and self-flashed OTA firmware (D) | Runner-up |
| Even Realities G1/G2 | G2 yes; G1 U | BLE (D) | Only via MentraOS or community reverse-engineered docs (D for their existence) | Official SDK license U | U | Reach it through MentraOS |
| Plaud NotePin | Yes (D) | BLE (D) | PCM during file sync (D); live stream U | Sample app Apache-2.0, **SDK binaries proprietary** (D) | Yes, per-user JWT from the vendor (D) | Not recommended |
| Limitless Pendant | No: sales stopped after acquisition (R) | Cloud export (D) | No live stream; post-hoc Ogg Opus export via REST (D) | Closed | Yes, API key (D) | Excluded |
| Bee | Yes (R, now Amazon) | U | No raw audio; processed data only (D) | U | Yes (D) | Excluded |
| OpenGlass | N/A | BLE (D) | Superseded | MIT (D) | No | Merged into Omi (D) |
| DIY XIAO ESP32-S3 pendant | Parts only | BLE (Owl) / Wi-Fi (xiaozhi) (D) | Yes, you own the firmware | MIT (D) | No | No maintained wearable project |

## Candidates

### Omi (baseline)

- **Audio (D):** BLE service `19B10000-E8F2-537E-4F6C-D104768A1214` with an audio data characteristic and a codec-type
  characteristic. Supported: PCM 16/8 kHz, µ-law 16/8 kHz, and Opus 16 kHz, all mono. Opus has been the default since
  firmware v1.0.3. [Protocol docs](https://docs.omi.me/doc/developer/Protocol)
- **License (D):** MIT. [BasedHardware/omi](https://github.com/BasedHardware/omi), about 13.6k stars, active, not
  archived.
- **Availability (D):** Omi and DevKit models sold on [omi.me](https://www.omi.me/).
- **Offline / BYOK:** U from primary docs. Because the BLE protocol is documented, local capture does not depend on the
  vendor cloud; this is how Murmur's connector works.

### Mentra Live / MentraOS (recommended)

- **Availability (D):** Mentra Live is sold on the [vendor site](https://mentraglass.com/pages/live).
- **Transport (D):** BLE and Wi-Fi.
- **Audio access (D):** the Miniapp SDK exposes `session.mic.onAudioChunk()`. `AudioChunkData.data` is base64 audio,
  "PCM or LC3 depending on the phone's mic mode", with optional `sampleRate` and `format` fields. The app manifest must
  declare the `MICROPHONE` permission, or the phone rejects the subscription with `PERMISSION_NOT_DECLARED`. Raw audio
  and transcription are separate subscriptions. [Audio chunks](https://docs.mentraglass.com/app-devs/core-concepts/microphone/audio-chunks)
- **Platforms (D):** the Mentra phone app runs on iOS 15.1+ and Android 12+. MentraOS also supports other glasses, including Even
  Realities G1/G2 and Vuzix Z100. [MentraOS](https://github.com/Mentra-Community/MentraOS)
- **License (D):** Apache-2.0 (`LICENSE`), about 2.4k stars, active default branch `dev`, not archived.
- **Offline (D):** Mentra publishes an offline speech and LLM assistant example,
  [Edge_AI_SmartGlasses](https://github.com/Mentra-Community/Edge_AI_SmartGlasses). BYOK for transcription follows,
  because raw audio is available to the app.
- **Direct BLE:** a [Bluetooth SDK starter kit](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit)
  exists (D). Whether it gives raw microphone audio without the Mentra app or a Mentra account is **U**.
- **Background limits:** U.

### Brilliant Labs Halo (runner-up)

- **Availability (D):** Halo is sold on [brilliant.xyz](https://brilliant.xyz/). The earlier Frame is no longer offered
  in the official store.
- **Firmware (D):** [halo-firmware](https://github.com/brilliantlabsAR/halo-firmware) supports self-built firmware over
  OTA with "no cable, no dev kit, no vendor tooling". Its README states the repository "is therefore *not* uniformly
  Apache-2.0": Brilliant code is Apache-2.0 per file, but the vendored Alif Semiconductor SDK license "restricts use to
  Alif silicon and forbids relicensing under copyleft terms". GitHub reports the license as `NOASSERTION`.
- **SDK (D):** [brilliant_sdk](https://github.com/brilliantlabsAR/brilliant_sdk), BSD-3-Clause, Flutter, Python and
  Web Bluetooth.
- **Audio:** the README mentions "LE-Audio-style voice pipelines with on-device echo cancellation" (D), but documents no
  third-party microphone stream (U).

### Even Realities G1 / G2

- The vendor's [G1 page](https://www.evenrealities.com/g1) currently leads to G2. G1 new-sale availability is U.
- An Even Hub SDK for G2 is referenced publicly. Its microphone access and license terms are U; its documentation page
  did not load during this survey.
- Community BLE protocol notes for G1 exist, for example in [AGiXT/mobile](https://github.com/AGiXT/mobile). They are
  reverse-engineered, not vendor documentation, and are out of scope under this issue's rules.
- MentraOS already supports G1/G2 (D), so a MentraOS connector is the sanctioned path to this hardware.

### Plaud NotePin

- **Availability (D):** sold on [plaud.ai](https://www.plaud.ai/products/plaud-notepin).
- **SDK (D):** [plaud-sdk-public](https://github.com/Plaud-AI/plaud-sdk-public), iOS 14+ and Android 5.0+.
  `blePcmData` "delivers decoded PCM (640 bytes, 16kHz mono)" during file sync. A live microphone stream is U.
- **License (D):** the template app is Apache-2.0, but "the Plaud SDK binaries in the `sdk/` directory (iOS frameworks
  and Android AAR) are proprietary and distributed under a separate license." A connector would depend on
  closed binaries.
- **Authentication (D):** a per-user JWT obtained through the vendor's partner API, plus separate developer-portal keys
  for vendor transcription.

### Limitless Pendant (excluded)

- Meta's acquisition of Limitless and the end of Pendant sales to new customers were
  [reported on 2025-12-05](https://techcrunch.com/2025/12/05/meta-acquires-ai-device-startup-limitless/) (R).
- The developer API is a cloud REST API with an API key. Audio is exported after the fact as Ogg Opus, in windows of up
  to two hours (D). [Developers](https://www.limitless.ai/developers)
- Excluded: no longer sold new, and no live audio.

### Bee (excluded)

- Amazon's acquisition was [reported in July 2025](https://techcrunch.com/2025/07/22/amazon-acquires-bee-the-ai-wearable-that-records-everything-you-say/) (R).
- The developer [proxy and CLI](https://docs.bee.computer/docs/proxy) expose processed data (facts, to-dos,
  conversations, summaries) behind a vendor login (D). No raw or live audio is documented.
- Excluded: no raw audio.

### OpenGlass (superseded)

- The [repository](https://github.com/BasedHardware/OpenGlass) states it moved into the Omi repository and is no longer
  supported (D). MIT. The last push was 2025-09-22.

### DIY XIAO ESP32-S3 Sense pendant

- [OwlAIProject/Owl](https://github.com/OwlAIProject/Owl) (MIT) documents a XIAO ESP32-S3 Sense wearable over BLE (D),
  but its last push was 2024-03-17.
- [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) (MIT, about 30k stars, active) is a maintained ESP32 voice
  assistant. It is Wi-Fi or cellular first and not a wearable reference design (D).
- No maintained, BLE-first open pendant design was found. A DIY source is better served by Murmur's generic network or
  local-audio connectors than by a device-specific one.

## Recommendation: MentraOS

Build the next connector against **MentraOS**, capturing through `session.mic.onAudioChunk()`.

**Why**

- It is the only candidate besides Omi with a documented third-party raw-audio API.
- Its core repository is Apache-2.0, the same license as Murmur, so code and protocol references can be adapted
  without license friction. Halo's firmware (Alif SDK terms) and Plaud's proprietary SDK binaries both fail this test.
- The hardware is on sale from an independent vendor. Limitless and Bee were acquired and lost new sales or open
  access.
- MentraOS abstracts several glasses, including Mentra Live, Even Realities G1/G2 and Vuzix Z100, so one connector
  reaches a whole device category. That fits Murmur's source-neutral design.
- A local path exists: raw audio in the app plus Mentra's offline assistant example makes offline transcription and
  BYOK feasible.

**Tradeoffs and risks**

- **Account boundary (U).** Confirm whether `onAudioChunk` requires a Mentra account, miniapp registration or the
  Mentra phone app, and whether the Bluetooth SDK starter kit reaches the microphone directly. This decides whether
  the connector can run fully locally, and it should be the first task.
- **Codec varies by mic mode.** The stream can be PCM or LC3. The connector must read `format` and `sampleRate` per
  chunk, decode LC3 or request PCM, and report the result through `AudioFrame.format`. It must never assume 16 kHz.
- **Glasses, not a pendant.** Capture posture, battery life and background behavior differ from Omi. Background limits
  are U and need physical validation before the connector is marked supported.
- **Moving target.** Re-check availability and SDK APIs at implementation time.

**Runner-up: Brilliant Labs Halo.** It is the most open hardware here: user-built firmware over OTA, BSD-3-Clause SDKs,
and no vendor tooling. It becomes the better choice if Brilliant documents third-party microphone streaming and the
Alif SDK terms are confirmed compatible with what Murmur would adapt. That is worth a follow-up question to the vendor.

## Out of scope

No hardware was purchased, no connector was implemented, and no closed protocol was reverse engineered. Community
reverse-engineering notes are listed only to show they exist, not as sources.
