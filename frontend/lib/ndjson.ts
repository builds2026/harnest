export async function readNdjson<T>(
  response: Response,
  onValue: (value: T) => void,
): Promise<void> {
  if (!response.body) throw new Error("The run response did not include a stream.");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";

  while (true) {
    const { value, done } = await reader.read();
    pending += value ?? "";
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onValue(JSON.parse(line) as T);
    }
    if (done) break;
  }

  if (pending.trim()) onValue(JSON.parse(pending) as T);
}
