import { z } from 'zod';

const step = z.object({
  reads: z.array(z.object({ path: z.string(), line: z.int().positive() })).max(3),
  labels: z.array(z.string().trim().min(2).max(64)).max(8),
});

// Keep the repository-reading agent separate from the public interviewer.
// Only short, observed interface labels cross into the public conversation.
export async function investigate(model, snapshot, messages) {
  const inventory = await snapshot.files();
  const paths = [];
  let size = 0;
  for (const path of inventory.paths) {
    if ((size += path.length + 1) > 80_000) break;
    paths.push(path);
  }
  const allowed = new Set(paths);
  const excerpts = [];
  const seen = new Set();
  const labels = new Set();
  for (let turn = 0; paths.length && turn < 3; turn++) {
    const last = turn === 2;
    const result = await model('investigate-interface', [
      'Locate the page or product feature involved in this conversation. You have a read-only file tool.',
      'Choose exact paths and starting line numbers for reads. Follow imports or request later lines based on results.',
      'Select only relevant literal user-visible UI labels from rendered markup or quoted strings in the observed excerpts.',
      'Exclude identifiers, code, docs, configuration, secrets and internal messages. Use an empty labels array when uncertain.',
      last ? 'Read budget exhausted. Return labels only and empty reads.' : 'Return empty reads to finish when you have enough evidence.',
    ].join(' '), { messages, paths, excerpts }, step);
    for (const label of result.labels) {
      if (!/^[\p{L}\p{N}][\p{L}\p{N} ()（）·、，-]*$/u.test(label)) continue;
      const escaped = label.replace(/[()]/g, '\\$&');
      const uiLiteral = new RegExp(`>\\s*${escaped}\\s*<|(?:aria-label|placeholder)\\s*=\\s*["']${escaped}["']|(?:button|field|heading|submit)\\(\\s*["']${escaped}["']`);
      if (excerpts.some(({ path, source }) => /\.(?:[cm]?[jt]sx?|vue|svelte|html)$/i.test(path) && uiLiteral.test(source))) labels.add(label);
    }
    if (last) break;
    const previous = excerpts.length;
    for (const { path, line } of result.reads) {
      const key = path + ':' + line;
      if (!allowed.has(path) || seen.has(key)) continue;
      seen.add(key);
      const source = (await snapshot.read(path)).split('\n').slice(line - 1, line + 79).join('\n').slice(0, 5000);
      excerpts.push({ path, line, source });
    }
    if (excerpts.length === previous) break;
  }
  return [...labels];
}
