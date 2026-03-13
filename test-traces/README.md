# Test Traces

This directory contains various Chrome DevTools performance traces for testing `trace-server`.

## Included Traces

### Unit Test Fixtures
- **`trace-minimal.json`** (830B) — 3 events, used by unit tests
- **`trace-full.json`** (393B) — 2 events in legacy array format, used by unit tests

### Synthetic Fixtures
- **`trace-realistic.json`** (~80KB) — ~500+ events exercising all heuristic endpoints (network, screenshots, long tasks, threads, categories)
- **`trace-realistic.json.gz`** — gzipped version
- **`generate-fixture.ts`** — Bun script to regenerate (`bun run test-traces/generate-fixture.ts`)

### Real Website Traces
- **`reddit-scroll.json.gz`** (512KB) — Reddit homepage with scrolling (3.3MB uncompressed, 3-5 seconds)
- **`bbc-news-navigation.json.gz`** (11.1MB) — BBC News homepage + article navigation (103MB uncompressed, full navigation flow)
- **`vercel-contact-nav.json.gz`** (36.6MB) — Vercel.com with page navigation (495MB uncompressed, 240 seconds)

The `.gz` files are kept in the repo for convenience. Uncompressed JSON files are gitignored (except the unit test fixtures).

## Recording Your Own Traces

1. Open Chrome DevTools (F12)
2. Go to the Performance tab
3. Click the record button (circle icon)
4. Interact with the page (scroll, click, navigate)
5. Stop recording
6. Export via the download button (down arrow icon)

## Using Traces with trace-server

```bash
# Load a trace
trace-server load ./test-traces/reddit-scroll.json.gz

# Or use uncompressed
gunzip test-traces/reddit-scroll.json.gz
trace-server load ./test-traces/reddit-scroll.json
```

## Large Trace Collection

For more comprehensive test traces (27-177MB), download from:
https://tokiwa.space/f/duty-should-choose.zip
