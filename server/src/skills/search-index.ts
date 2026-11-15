import type { Skill, SkillFileRead } from '@mcp-skills/shared';
import type { SearchResult } from 'minisearch';
import MiniSearch from 'minisearch';
import { parseMarkdown } from './markdown.ts';
import type { Section } from './sections.ts';
import { splitSections } from './sections.ts';

/** The `path` of a passage in the skill's own body (SKILL.md, or the flat `.md`), rather than in a supporting file. */
export const BODY_PATH = '';

/** One section of a skill that matched a query. */
export interface Passage {
  /** The supporting file it is in, relative to the skill's folder; {@link BODY_PATH} for the skill's own body. */
  path: string;
  /** The heading it sits under; empty for text before a file's first heading. */
  heading: string;
  /** A short stretch of its text around the first matched term, whitespace collapsed. */
  snippet: string;
  /** Its BM25 score; only comparable to the scores of the same search. */
  score: number;
}

/** One skill a search found, with the sections that made it match. */
export interface SkillHit {
  skill: Skill;
  /** Its rank score; 0 when the search had no query and nothing was ranked. */
  score: number;
  /** Its best-matching sections, best first; empty when the search had no query. */
  passages: Passage[];
}

/** What a catalogue search takes. */
export interface SkillSearchOptions {
  /** Free text; the terms are ranked by BM25, so a skill need not contain all of them. */
  query: string;
  /** Keeps only the skills carrying at least one of these, case ignored; empty keeps them all. */
  tags: string[];
  /** Most skills to return when the query ranks them. */
  limit: number;
}

/** What the index needs from its host. */
export interface SkillSearchIndexDeps {
  /** Every skill to index, whichever endpoint serves it; a search then narrows to the skills it is given. */
  getSkills: () => Skill[];
  /** Reads a supporting file; left out, only skill metadata and bodies are indexed. */
  readFile?: (skillName: string, relPath: string) => Promise<Pick<SkillFileRead, 'content' | 'binary'>>;
}

/** One indexed document: a skill's metadata, or one section of its body or a supporting file. */
interface IndexDoc {
  id: number;
  name?: string;
  description?: string;
  tags?: string;
  path?: string;
  heading?: string;
  text?: string;
}

/** What the index remembers about a document beyond its text fields. */
interface DocInfo {
  skill: string;
  /** Present for a section document; absent for the metadata document. */
  chunk?: Section & { path: string };
}

/** Words too common to tell skills apart; dropped from documents and queries alike. */
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can do does for from has have how i if in into is it its me my not of on or ' +
    'should so than that the their then there these this those to was we what when where which while who why ' +
    'will with would you your'
  ).split(' '),
);

/** How much a hit in each field counts, relative to body text. */
const FIELD_BOOST = { name: 4, tags: 3, description: 2, heading: 2, path: 1.5, text: 1 };

/** Shortest query term that also matches longer words it begins (`menu` → `menus`). */
const MIN_PREFIX_LENGTH = 3;

/** Shortest query term that also matches near-misses (`comobox` → `combobox`). */
const MIN_FUZZY_LENGTH = 5;

/** The edit distance a fuzzy term may be off by, as a fraction of its length. */
const FUZZY_DISTANCE = 0.2;

/** How many of a skill's best sections add to its score; further ones add nothing. */
const COUNTED_SECTIONS = 3;

/** Each counted section adds this fraction of what the one before it added (best adds all of its score). */
const SECTION_DECAY = 0.5;

/** How many of a skill's best-matching sections a catalogue search names. */
export const PASSAGES_PER_SKILL = 3;

/** Score multiplier for a skill whose metadata or body holds every query term verbatim. */
const LITERAL_BONUS = 1.25;

/** Score for a skill found only by verbatim substring (mid-word), so it ranks after every BM25 hit. */
const LITERAL_ONLY_SCORE = 1e-6;

/** Largest supporting file that is read and indexed, in bytes. */
const MAX_INDEXED_FILE_BYTES = 262_144; // 256 KiB

/** Characters of a snippet. */
const SNIPPET_LENGTH = 200;

/** Characters a snippet starts before the first matched term. */
const SNIPPET_LEAD = 60;

/** Extensions of the supporting files that are split at their headings; others are one section each. */
const MARKDOWN_EXT_RE = /\.(md|markdown|mdx)$/i;

/** A file's extension, dropped before its path is indexed so `.md` does not match everything. */
const EXTENSION_RE = /\.[^./]+$/;

/** The boundary inside a camelCase word, where `useAppForm` is split into `use`, `app`, `form`. */
const CAMEL_BOUNDARY_RE = /(?<=[a-z0-9])(?=[A-Z])/;

/**
 * Turns a document token into its index terms: the lower-cased word, plus its camelCase parts.
 *
 * @param token - One token of a document field.
 * @returns The terms, or null for a stop word.
 */
function indexTerms(token: string): string[] | null {
  const lower = token.toLowerCase();
  if (STOP_WORDS.has(lower)) {
    return null;
  }
  const parts = token
    .split(CAMEL_BOUNDARY_RE)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 1 && part !== lower && STOP_WORDS.has(part) === false);
  return [lower, ...new Set(parts)];
}

/**
 * Turns a query token into its search term.
 *
 * @param token - One token of the query.
 * @returns The lower-cased word, or null for a stop word.
 */
function queryTerm(token: string): string | null {
  const lower = token.toLowerCase();
  return STOP_WORDS.has(lower) ? null : lower;
}

/**
 * Splits a query into its distinct search terms, as the index sees them.
 *
 * @param query - The free-text query.
 * @returns The terms, stop words dropped.
 */
function queryTerms(query: string): string[] {
  const tokenize = MiniSearch.getDefault('tokenize') as (text: string) => string[];
  const terms = tokenize(query)
    .map(queryTerm)
    .filter((term): term is string => typeof term === 'string' && term.length > 0);
  return [...new Set(terms)];
}

/**
 * Tells whether a skill carries at least one of the wanted tags.
 *
 * @param skill - The skill to test.
 * @param wantTags - Lower-cased tags; none means every skill matches.
 * @returns True when the skill passes the tag filter.
 */
function matchesTags(skill: Skill, wantTags: string[]): boolean {
  if (wantTags.length === 0) {
    return true;
  }
  const skillTags = skill.tags.map((t) => t.toLowerCase());
  return wantTags.some((t) => skillTags.includes(t));
}

/**
 * Tells whether every word of a query appears verbatim in a skill's name, description, tags or body.
 *
 * @param skill - The skill to test.
 * @param words - Lower-cased query words.
 * @returns True when each is a substring there; false for no words.
 *
 * @remarks
 * This was the whole search before ranking. It is kept so a mid-word literal (`AppForm` in `useAppForm`) still finds
 * the skill, and so a skill holding every word ranks above one holding some.
 */
function holdsEveryWord(skill: Skill, words: string[]): boolean {
  if (words.length === 0) {
    return false;
  }
  const haystack = `${skill.name}\n${skill.description}\n${skill.tags.join(' ')}\n${skill.body}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * Splits a file's text into the sections that are indexed.
 *
 * @param content - The file's text.
 * @param relPath - Its path, which decides whether it is Markdown.
 * @returns Its sections; a Markdown file loses its frontmatter and splits at headings, any other is one section.
 */
function fileSections(content: string, relPath: string): Section[] {
  if (MARKDOWN_EXT_RE.test(relPath)) {
    return splitSections(parseMarkdown(content).body);
  }
  const text = content.trim();
  return text.length > 0 ? [{ heading: '', text }] : [];
}

/**
 * Cuts a short stretch of a section around the first term the search matched in it.
 *
 * @param text - The section's text.
 * @param terms - The document terms the search matched.
 * @returns The stretch, whitespace collapsed, with `…` where it was cut.
 */
function snippetOf(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0);
  const first = positions.length > 0 ? Math.min(...positions) : 0;
  // Start on a word boundary, so the snippet does not open on half a word.
  const leadStart = Math.max(0, first - SNIPPET_LEAD);
  const space = leadStart > 0 ? flat.indexOf(' ', leadStart) : -1;
  const start = space >= 0 && space < first ? space + 1 : leadStart;
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** Orders hits best first, then by name so equal scores come out the same way every time. */
function byScore(a: { score: number; name: string }, b: { score: number; name: string }): number {
  return b.score - a.score || a.name.localeCompare(b.name);
}

/**
 * A BM25 index over skills: each one's metadata, and each section of its body and its text supporting files.
 *
 * @remarks
 * It is built on the first search and kept current from then on: before each search, any skill whose object the
 * store has replaced (every load and reload makes new ones) is indexed again, and any the store dropped is removed.
 * One index serves every endpoint of a store; each search narrows it to the skills its endpoint serves.
 */
export class SkillSearchIndex {
  private readonly deps: SkillSearchIndexDeps;
  private readonly mini: MiniSearch<IndexDoc>;
  /** Per indexed document, which skill it belongs to and, for a section, the section itself. */
  private readonly docs = new Map<number, DocInfo>();
  /** Per skill name, the skill object last indexed and the ids of its documents. */
  private readonly indexed = new Map<string, { skill: Skill; ids: number[] }>();
  /** The id the next document gets. */
  private nextId = 0;
  /** The refresh in progress or last finished; refreshes run one at a time. */
  private refreshing: Promise<void> = Promise.resolve();

  /**
   * Sets the index up empty; nothing is read until the first search.
   *
   * @param deps - Where the skills and their files come from.
   */
  constructor(deps: SkillSearchIndexDeps) {
    this.deps = deps;
    this.mini = new MiniSearch<IndexDoc>({
      fields: ['name', 'description', 'tags', 'path', 'heading', 'text'],
      storeFields: [],
      processTerm: indexTerms,
      searchOptions: {
        processTerm: queryTerm,
        boost: FIELD_BOOST,
        combineWith: 'OR',
        prefix: (term) => term.length >= MIN_PREFIX_LENGTH,
        fuzzy: (term) => (term.length >= MIN_FUZZY_LENGTH ? FUZZY_DISTANCE : false),
      },
    });
  }

  /**
   * Ranks skills against a query, after a tag filter.
   *
   * @param served - The skills to search among, in the order to keep when nothing is ranked.
   * @param options - The query, tag filter and result cap.
   * @returns With a query, the matches best first, at most `limit`, each with its best sections; without one, every
   * skill that passes the tag filter, in the given order and unranked.
   */
  async search(served: Skill[], options: SkillSearchOptions): Promise<SkillHit[]> {
    const wantTags = options.tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    const candidates = served.filter((skill) => matchesTags(skill, wantTags));
    const terms = queryTerms(options.query);
    const words = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return candidates.map((skill) => ({ skill, score: 0, passages: [] }));
    }

    await this.refresh();
    const byName = new Map(candidates.map((skill) => [skill.name, skill]));
    const results =
      terms.length > 0 ? this.mini.search(options.query, { filter: (r) => byName.has(this.skillOf(r)) }) : [];

    const perSkill = new Map<string, { meta: number; sections: SearchResult[]; terms: Set<string> }>();
    for (const result of results) {
      const name = this.skillOf(result);
      const entry = perSkill.get(name) ?? { meta: 0, sections: [], terms: new Set<string>() };
      perSkill.set(name, entry);
      for (const term of result.queryTerms) {
        entry.terms.add(term);
      }
      if (this.docs.get(result.id)?.chunk) {
        entry.sections.push(result);
      } else {
        entry.meta += result.score;
      }
    }

    // A query word that is all stop words still counts for the verbatim check, so `how to` finds something.
    const literalWords = words.filter((word) => STOP_WORDS.has(word) === false);
    const checkedWords = literalWords.length > 0 ? literalWords : words;
    const hits: Array<SkillHit & { name: string }> = [];
    for (const skill of candidates) {
      const entry = perSkill.get(skill.name);
      const isLiteral = holdsEveryWord(skill, checkedWords);
      if (entry === undefined) {
        if (isLiteral) {
          hits.push({ name: skill.name, skill, score: LITERAL_ONLY_SCORE, passages: [] });
        }
        continue;
      }
      const sectionScore = entry.sections
        .slice(0, COUNTED_SECTIONS)
        .reduce((sum, result, i) => sum + result.score * SECTION_DECAY ** i, 0);
      // Matching more of the query's terms counts: a skill with all of them keeps its whole score, one with
      // a single term of many keeps about half.
      const coverage = terms.length > 0 ? entry.terms.size / terms.length : 1;
      const score = (entry.meta + sectionScore) * ((1 + coverage) / 2) * (isLiteral ? LITERAL_BONUS : 1);
      const passages = entry.sections.slice(0, PASSAGES_PER_SKILL).map((result) => this.passageOf(result));
      hits.push({ name: skill.name, skill, score, passages });
    }
    return hits
      .sort(byScore)
      .slice(0, options.limit)
      .map(({ skill, score, passages }) => ({ skill, score, passages }));
  }

  /**
   * Ranks the sections of one skill against a query.
   *
   * @param skill - The skill to look inside.
   * @param query - Free text.
   * @param limit - Most sections to return.
   * @returns The matching sections of its body and supporting files, best first.
   */
  async searchPassages(skill: Skill, query: string, limit: number): Promise<Passage[]> {
    if (queryTerms(query).length === 0) {
      return [];
    }
    await this.refresh();
    const results = this.mini.search(query, {
      filter: (r) => {
        const info = this.docs.get(r.id);
        return info?.skill === skill.name && info.chunk !== undefined;
      },
    });
    return results.slice(0, limit).map((result) => this.passageOf(result));
  }

  /**
   * Brings the index up to date with the store, one refresh at a time.
   *
   * @returns Once every skill the store holds now is indexed as it is now.
   */
  private refresh(): Promise<void> {
    this.refreshing = this.refreshing
      .then(() => this.sync())
      .catch((err: unknown) => {
        console.error('Skill search index refresh failed:', err);
      });
    return this.refreshing;
  }

  /** Drops the skills the store no longer holds and indexes again each one it has replaced. */
  private async sync(): Promise<void> {
    const current = this.deps.getSkills();
    const names = new Set(current.map((skill) => skill.name));
    for (const name of [...this.indexed.keys()]) {
      if (names.has(name) === false) {
        this.drop(name);
      }
    }
    const stale = current.filter((skill) => this.indexed.get(skill.name)?.skill !== skill);
    const built = await Promise.all(stale.map(async (skill) => ({ skill, sections: await this.sectionsOf(skill) })));
    for (const { skill, sections } of built) {
      this.drop(skill.name);
      this.add(skill, sections);
    }
  }

  /**
   * Collects every section of a skill that is indexed: its body's, then each text supporting file's.
   *
   * @param skill - The skill to read.
   * @returns The sections with the path each came from; a file that cannot be read, is binary or is too big is left
   * out.
   */
  private async sectionsOf(skill: Skill): Promise<Array<Section & { path: string }>> {
    const sections = splitSections(skill.body).map((section) => ({ ...section, path: BODY_PATH }));
    const readFile = this.deps.readFile;
    if (readFile === undefined) {
      return sections;
    }
    const files = skill.files.filter((file) => file.type === 'file' && file.size <= MAX_INDEXED_FILE_BYTES);
    const reads = await Promise.all(
      files.map(async (file) => {
        try {
          const read = await readFile(skill.name, file.path);
          return read.binary ? [] : fileSections(read.content, file.path).map((s) => ({ ...s, path: file.path }));
        } catch {
          // Deleted or replaced between the listing and the read: the next refresh picks the new state up.
          return [];
        }
      }),
    );
    return [...sections, ...reads.flat()];
  }

  /**
   * Adds a skill's documents: one for its metadata and one per section.
   *
   * @param skill - The skill.
   * @param sections - Its sections, as {@link sectionsOf} returns them.
   */
  private add(skill: Skill, sections: Array<Section & { path: string }>): void {
    const ids: number[] = [];
    const docs: IndexDoc[] = [];
    const metaId = this.nextId++;
    ids.push(metaId);
    this.docs.set(metaId, { skill: skill.name });
    docs.push({ id: metaId, name: skill.name, description: skill.description, tags: skill.tags.join(' ') });
    for (const section of sections) {
      const id = this.nextId++;
      ids.push(id);
      this.docs.set(id, { skill: skill.name, chunk: section });
      docs.push({
        id,
        path: section.path.replace(EXTENSION_RE, ''),
        heading: section.heading,
        text: section.text,
      });
    }
    this.mini.addAll(docs);
    this.indexed.set(skill.name, { skill, ids });
  }

  /**
   * Removes every document of one skill.
   *
   * @param name - The skill's name; nothing happens when it is not indexed.
   */
  private drop(name: string): void {
    const entry = this.indexed.get(name);
    if (entry === undefined) {
      return;
    }
    for (const id of entry.ids) {
      this.mini.discard(id);
      this.docs.delete(id);
    }
    this.indexed.delete(name);
  }

  /**
   * Names the skill a search result belongs to.
   *
   * @param result - A result of this index.
   * @returns The skill's name; empty if the document has since been dropped.
   */
  private skillOf(result: { id: number }): string {
    return this.docs.get(result.id)?.skill ?? '';
  }

  /**
   * Describes the section a search result matched.
   *
   * @param result - A result for a section document.
   * @returns The passage, its snippet cut around the first matched term.
   */
  private passageOf(result: SearchResult): Passage {
    const chunk = this.docs.get(result.id)?.chunk;
    return {
      path: chunk?.path ?? BODY_PATH,
      heading: chunk?.heading ?? '',
      snippet: snippetOf(chunk?.text ?? '', result.terms),
      score: result.score,
    };
  }
}
