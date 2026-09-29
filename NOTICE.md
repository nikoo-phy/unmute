# NOTICE

## Class Copilot (课堂同传)

This file accompanies `LICENSE.md`. It records **what in this project is original to the
authors**, **what is third-party**, and **the history of this project's licensing**.

Authors: **nikoo-phy** and **Bradleymao2**
Repository: **https://github.com/nikoo-phy/unmute**

---

## 1. Statement of Originality

The following parts of this work were originally conceived, designed, and written by the
authors, and constitute the original expression of this project:

- **Application architecture and behavior** — the single-file, dependency-free design; a
  session timeline that excludes paused time from every exported timestamp; the paragraph
  "sealing" policy (character threshold plus a maximum-age fallback); and the speech
  recognition recovery layer (bounded exponential backoff, with connection health measured by
  session survival rather than by the arrival of a final result).
- **Prompt engineering** — the system and user prompts for real-time translation, question
  detection, spoken-answer generation, and rolling lecture summarization, including their
  output contracts and field-level constraints.
- **Bilingual terminology glossary** — the curated Chinese/English glossary shipped with the
  application, compiled by the authors.
- **Microphone diagnostics layer** — the two-stage near-field / far-field level test, the
  loopback-device and virtual-microphone detection heuristics, and the input-device
  enumeration and reporting logic.
- **Document generation** — the zero-dependency `.docx` writer, ZIP writer, and CRC-32
  implementation, written from scratch for this project.
- **User interface and visual system** — the layout, typography scale, interaction model,
  keyboard shortcuts, floating subtitle window, and all Chinese-language interface copy and
  diagnostic text.

Originality is claimed **only** over the material listed above. The authors do **not** claim
originality over the third-party components, platforms, and services described in Section 3.

---

## 2. Licensing History

This is the honest record of how the project's licensing has changed. It matters because a
license already granted cannot be revoked, so the boundary between versions must be stated
plainly rather than glossed over.

| Version / point in history | License |
|---|---|
| Up to and including tag **`v1.0-mit`** | MIT License |
| From the release following that tag onward | `LICENSE.md` in this repository (non-commercial) |

> Versions up to and including `v1.0-mit` were released under the MIT License. MIT grants
> already made for those versions **remain in effect and cannot be revoked**, and copies
> obtained under MIT may still be used commercially by their recipients. From the release
> after `v1.0-mit` onward, this project is licensed under the non-commercial terms in
> `LICENSE.md`. Commercial use of any later version is not permitted without written
> permission.

Note also that `git` history retains the earlier `LICENSE` file. Anyone who checks out a
commit from the MIT period obtains that commit's licensing, and a GitHub fork created before
the change keeps the license it was forked under. Relicensing governs future releases only; it
does not and cannot reach backwards.

---

## 3. Third-Party Components, Services, and Acknowledgements

This project builds on, depends on, or interoperates with the following. Their own terms
govern their use, and nothing in `LICENSE.md` grants rights to them.

- **Speech recognition — Web Speech API.** Recognition is performed by the browser's built-in
  `SpeechRecognition` interface. This application captures no audio itself and transmits no
  audio on its own behalf. When running in Microsoft Edge, audio is processed by Microsoft's
  speech service; when running in Google Chrome, by Google's speech service. Those services
  are governed by their respective providers' terms and privacy policies.
- **Language model API.** Translation, answer generation, and summarization are performed by a
  third-party LLM API endpoint that the user configures, using the user's own credentials. The
  default endpoint is a DeepSeek-compatible API. This project ships **no model weights and no
  API keys**, and the authors are not affiliated with any model provider.
- **Upstream codebase.** The application is built from *class-copilot*, the authors' own earlier
  repository — its prompt, document and core modules, and its web front end. It is the authors'
  own work, and no third-party code is included from it.
- **Typefaces.** The interface references **Inter**, **Noto Sans SC**, **Segoe UI Variable**,
  and **Cascadia Mono**. These fonts are **not bundled** with this project; they are resolved
  from the user's operating system or obtained separately under their own licenses. Inter and
  Noto Sans SC are licensed under the SIL Open Font License.

---

## 4. How to Report a Problem

If you believe this project misattributes your work, or uses your material in a way this
notice does not describe, please open an issue at
**https://github.com/nikoo-phy/unmute**. Attribution errors are treated as bugs and fixed
promptly.
