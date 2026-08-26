import { mkdir, writeFile } from "node:fs/promises";

import {
  commandJsonSchema,
  createRunJsonSchema,
  idempotencyKeyJsonSchema,
  interactionJsonSchema,
  permissionJsonSchema,
  protocolJsonSchema,
  snapshotJsonSchema,
} from "../dist/index.js";

const directory = new URL("../schema/", import.meta.url);
await mkdir(directory, { recursive: true });

for (const [name, schema] of Object.entries({
  "wire.schema.json": protocolJsonSchema,
  "command.schema.json": commandJsonSchema,
  "create-run.schema.json": createRunJsonSchema,
  "idempotency-key.schema.json": idempotencyKeyJsonSchema,
  "interaction.schema.json": interactionJsonSchema,
  "permission.schema.json": permissionJsonSchema,
  "snapshot-response.schema.json": snapshotJsonSchema,
})) {
  await writeFile(new URL(name, directory), `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}
