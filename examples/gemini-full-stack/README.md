# Gemini research + code harness

`harnest.yaml` is the practical harness: Gemini, static Context, project Memory, Web Search,
Web Scrape, an isolated Code Runner, bounded multi-turn Tool use, text output, and persisted Trace.
Secrets never appear in YAML.

## Easiest setup: Studio

```powershell
npm run harnest -- studio examples/gemini-full-stack/harnest.yaml
```

Studio reads the declared IDs and opens the three missing Connections in order:

1. `gemini-main` — choose Google AI Studio and paste its API key.
2. `web-main` — choose Firecrawl and paste its API key.
3. `sandbox-main` — choose Node.js; Docker or Podman is detected, the image is pulled, tested, and approved.

Save, Validate, enter a request, and Run. Tool calls show one bounded approval dialog before
external transfer or sandbox execution. Run output and every node/tool event appear in Trace.

## CLI setup

```powershell
$env:GEMINI_API_KEY = "your-google-ai-studio-key"
$env:FIRECRAWL_API_KEY = "your-firecrawl-key"

npm run harnest -- connect gemini examples/gemini-full-stack/harnest.yaml -- --id gemini-main --secret-env GEMINI_API_KEY
npm run harnest -- connect firecrawl examples/gemini-full-stack/harnest.yaml -- --id web-main --secret-env FIRECRAWL_API_KEY
npm run harnest -- connect sandbox examples/gemini-full-stack/harnest.yaml -- --id sandbox-main --runtime node
npm run harnest -- validate examples/gemini-full-stack/harnest.yaml
npm run harnest -- run examples/gemini-full-stack/harnest.yaml -- --input "공식 출처를 검색하고 17*23을 코드로 검산해줘" --approve-tool builtin.web-search --approve-tool builtin.web-scrape --approve-tool builtin.code-runner
```

For a self-hosted SearXNG instance, create `web-main` with `connect searxng --url <.../search>`.
SearXNG provides Search only, so remove the Web Scrape node or use a custom scrape mapping.

`harnest.acceptance.yaml` remains the slower engine acceptance graph for Context files, Memory,
Skill resources, custom Tools, evaluation, Loop, Router, Join, and schema output. It is a test
fixture, not the everyday assistant configuration.
