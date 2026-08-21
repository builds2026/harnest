# Gemini assistant and full-stack acceptance test

`harnest.yaml` is a practical one-call Korean assistant. It uses Gemini 3.5 Flash-Lite and
returns the answer directly as text. `harnest.acceptance.yaml` is the slower exhaustive graph
that exercises Context, Memory, Skill, Tool calls, evaluation, Loop, Router, Join, and Trace.

It uses no stored key. Create a key in [Google AI Studio](https://aistudio.google.com/) and keep
it only in the `GEMINI_API_KEY` environment variable. The YAML deliberately contains only the
`env:GEMINI_API_KEY` reference.

```powershell
$env:GEMINI_API_KEY = "your-key-here"
npm run harnest -- validate examples/gemini-full-stack/harnest.yaml -- --allow-modules
npm run harnest -- run examples/gemini-full-stack/harnest.yaml -- --input "서울의 봄 날씨 특징을 간단히 설명해줘"
```

For the practical assistant Studio, no file or Tool capability is needed:

```powershell
npm run harnest -- studio examples/gemini-full-stack/harnest.yaml -- --port 3000
```

Run the exhaustive acceptance graph only when testing every component:

```powershell
npm run harnest -- test examples/gemini-full-stack/harnest.acceptance.yaml -- --allow-modules --allow-files --context-root knowledge --approve-tool demo.fixture-check --approve-tool demo.release-check
```

The acceptance graph deliberately makes two Gemini requests for the function-call round trip,
so it is a feature test rather than a chat configuration.
