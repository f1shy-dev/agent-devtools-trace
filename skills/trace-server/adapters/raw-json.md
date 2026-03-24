# Raw JSON dataset guide

Use this guide for arbitrary JSON / JSON.gz documents loaded into the dataset kernel. For the complete typed API (method signatures, interfaces, filter operators), see **`../reference.md`**.

Raw mode is a first-class product surface, not a weak fallback.

## What raw mode exposes

### Schema / catalog
- `ds.schema.paths()`
- `ds.schema.samples(path)`
- `raw.schema.paths`

### Inferred tables
- `raw.inferred.*`
- nested arrays become inferred tables where possible

### Blob extraction
- `raw.embeddedBlobs`
- detects data URLs
- detects wrapper objects like `{ body, encoding: 'base64', mimeType }`
- detects byte-array blobs
- detects gzip/base64 wrapped text or JSON
- records confidence / decoded kind / media type

### Reports
- `raw.summary`

### Collections
- `raw.document`
- `raw.embedded-blobs`

## Recommended workflow

### Start with path discovery

```bash
trace-server query <session> "
return table((await ds.schema.paths()).slice(0, 30));
"
```

### Inspect the readable summary

```bash
trace-server query <session> "
return await ds.reports.get('raw.summary').pretty();
"
```

### Inspect inferred tables

```bash
trace-server query <session> "
return await ds.tables.get('raw.inferred.rows').table();
"
```

### Inspect embedded blobs

```bash
trace-server query <session> "
return await ds.tables.get('raw.embeddedBlobs').table();
"
```

### Export blobs

```bash
trace-server export <session> raw.embedded-blobs
```

## Useful query patterns

Sample a path:

```js
await ds.schema.samples('$.rows[].name')
```

Filter an inferred table:

```js
await ds.tables
  .get('raw.inferred.rows')
  .where('id', '>=', 2)
  .select(['name'])
  .rows()
```

Readable custom summary:

```js
const blobs = await ds.tables.get('raw.embeddedBlobs').rows();
const paths = await ds.schema.paths();
return [
  `paths ${paths.length}`,
  `embeddedBlobs ${blobs.length}`,
  ...blobs.slice(0, 5).map(blob => `${blob.path} ${blob.mediaType} ${blob.sizeBytes}b`),
].join('\n');
```

## Files and artifacts

Export the original document:

```js
await ds.files.exportCollection('raw.document')
```

List artifacts:

```js
await ds.artifacts.list()
```

Materialize a discovered blob artifact:

```js
await ds.files.materializeArtifact('artifact:raw:embedded:0')
```
