import { z } from 'zod';

const text = z.string().trim().min(1).max(5000);
const short = text.max(500);
const complaint = z.object({ problem: short, context: short, outcome: short, quotes: z.array(short).min(1).max(5) });
const reference = z.object({ path: z.string(), start: z.int().positive(), end: z.int().positive() });
export const draftSections = z.object({
  title: short, problem: text, userScenarios: text, currentBehavior: text, desiredBehavior: text,
  scope: text, acceptance: text, openQuestions: z.string().trim().max(5000),
});

export function createAnalysis(model) {
  return {
    clarify(messages) {
      return model('clarify', [
        'Identify real user problems, context and expected outcomes. Ask one focused follow-up at a time when facts are missing.',
        'If ready, separate independent requests and offer them for confirmation. Never invent answers.',
        'Return {reply: string, needs: [{problem, context, outcome, quotes: [exact contiguous excerpts from user messages]}]}. Return needs: [] while asking a question.',
      ].join(' '), messages, z.object({ reply: text, needs: z.array(complaint).max(8) }));
    },
    async classify(need, plans) {
      const schema = z.object({
        verdict: z.enum(['accepted', 'rejected', 'review']),
        reason: text,
        evidence: z.array(z.object({ index: z.int().nonnegative(), quote: text })).max(8),
      });
      const data = { need, plans: plans.map(({ text }, index) => ({ index, text })) };
      const result = await model('classify', [
        'Judge the clarified need using only the active product plans. A silence, weak match, conflicting policies or ambiguity means review.',
        'Accept only on affirmative support. Reject only when the need materially contradicts an explicit direction or restriction.',
        'Return {verdict: accepted|rejected|review, reason, evidence: [{index, quote: exact contiguous excerpt from that plan}]} with meaningful verbatim quotes.',
      ].join(' '), data, schema);
      const evidence = result.evidence.filter(ref => ref.quote.length >= 4 && plans[ref.index]?.text.includes(ref.quote));
      const insufficient = evidence.length === 0 || evidence.length !== result.evidence.length;
      if (result.verdict !== 'review' && insufficient) {
        return { verdict: 'review', reason: '规划材料中的引文不足以支持自动裁定。' + result.reason, evidence };
      }
      if (result.verdict === 'rejected') {
        const check = await model('verify-rejection', [
          'Independently evaluate the request against all product planning material.',
          'Confirm only an explicit contradiction established by the supplied verbatim evidence, with no conflicting or overriding policy.',
          'Return {confirmed: boolean, reason: string}. Silence, uncertainty or a compatible interpretation means false.',
        ].join(' '), { ...data, evidence }, z.object({ confirmed: z.boolean(), reason: text }));
        if (!check.confirmed) return { verdict: 'review', reason: check.reason, evidence };
      }
      return { ...result, evidence };
    },
    selectFiles(need, paths, knownPaths) {
      return model('select-files', [
        'Select likely implementation entry points, UI, tests and relevant requirements for this user need.',
        'Use exact paths from the provided repository inventory. Previously read paths are already in knownPaths.',
        'Return {paths:[string]} with at most 12 new paths. Prefer files that directly prove current product behavior.',
      ].join(' '), { need, paths, knownPaths }, z.object({ paths: z.array(z.string()).max(12) }));
    },
    async analyze(need, context, candidates) {
      const schema = z.object({
        summary: text,
        parts: z.array(z.object({
          title: short, goal: text, current: text, change: text, reason: text,
          kind: z.enum(['change', 'satisfied', 'verify']),
          references: z.array(reference).max(12),
          mergeWith: z.string().nullable(),
        })).min(1).max(12),
      });
      const result = await model('analyze', [
        'Assess current behavior using only repository excerpts. Split independent changes. Explicitly record satisfied portions and facts that still need verification.',
        'An incomplete search cannot prove a capability is absent. Mark unsupported claims verify. A change can describe a proposed improvement grounded in an observed implementation gap.',
        'Suggest merging only when user goal, scenario and target behavior agree, regardless of wording. Use an existing candidate ID or null.',
        'Return {summary, parts: [{title, goal, current, change, reason, kind: change|satisfied|verify, references:[{path,start,end}], mergeWith: string|null}]}.',
        'Line numbers are 1 based. Cite only file lines visible in the supplied excerpts. Unknown behavior belongs in a verify part.',
      ].join(' '), { need, ...context, candidates }, schema);
      const files = new Map(context.files.map(file => [file.path, file]));
      return {
        ...result,
        parts: result.parts.map(part => {
          const references = part.references.filter(ref => {
            const file = files.get(ref.path);
            return file && ref.end >= ref.start && ref.end <= file.lines.length && ref.end - ref.start < 30;
          }).map(ref => ({
            ...ref, excerpt: files.get(ref.path).lines.slice(ref.start - 1, ref.end).join('\n'),
          }));
          if (!references.length || references.length !== part.references.length) {
            return { ...part, current: '现有仓库证据不足，需核实当前行为。', kind: 'verify', references, mergeWith: null };
          }
          return { ...part, references };
        }),
      };
    },
    draft(inputs) {
      return model('draft', [
        'Write a decision-ready, bounded product requirements draft using only the supplied candidate changes.',
        'Keep unresolved facts in openQuestions. Write testable acceptance scenarios. Do not invent capabilities, planning authority or implementation facts.',
        'Return {title, problem, userScenarios, currentBehavior, desiredBehavior, scope, acceptance, openQuestions} with string values.',
      ].join(' '), inputs, draftSections);
    },
  };
}

export async function collectCode(snapshot, need, analysis) {
  const inventory = await snapshot.files();
  const visible = [];
  let pathCharacters = 0;
  for (const path of inventory.paths) {
    pathCharacters += path.length;
    if (pathCharacters > 85_000) break;
    visible.push(path);
  }
  const allowed = new Set(visible);
  const files = [];
  const readPaths = new Set();
  let clipped = false;
  // A second pass can follow a file's declaration, tests or neighboring module.
  for (let pass = 0; pass < 2; pass += 1) {
    const selection = await analysis.selectFiles(need, visible,
      files.map(({ path, lines }) => ({ path, preview: lines.join('\n').slice(0, 800) })));
    const paths = [...new Set(selection.paths)].filter(path => allowed.has(path) && !readPaths.has(path)).slice(0, 6);
    const content = await Promise.all(paths.map(path => snapshot.read(path)));
    for (const [index, path] of paths.entries()) {
      readPaths.add(path);
      const source = content[index];
      const lines = source.slice(0, 5000).split('\n');
      if (source.length > 5000) {
        lines.pop();
        clipped = true;
      }
      if (lines.length) files.push({ path, lines });
    }
    if (paths.length === 0) break;
  }
  return {
    files,
    coverage: {
      sourcePaths: inventory.paths.length, pathsOffered: visible.length, filesRead: files.length,
      inventoryTruncated: inventory.truncated || allowed.size < inventory.paths.length,
      excerptsTruncated: clipped,
    },
  };
}
