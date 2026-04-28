import * as fs from 'fs';
import * as path from 'path';

/** Shape of a single golden-dataset entry. */
interface GoldenEntry {
  id: string;
  user_prompt: string;
  retrieved_context: string;
  ideal_answer: string;
  expected_chunk_ids: string[];
}

const DATASET_PATH = path.join(__dirname, 'datasets/golden-dataset.json');

describe('Golden dataset — structural smoke test', () => {
  let entries: GoldenEntry[];

  beforeAll(() => {
    const raw = fs.readFileSync(DATASET_PATH, 'utf-8');
    entries = JSON.parse(raw) as GoldenEntry[];
  });

  it('loads a non-empty dataset', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every entry has a unique id', () => {
    const ids = entries.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every entry has the required fields with non-empty strings', () => {
    for (const entry of entries) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);

      expect(typeof entry.user_prompt).toBe('string');
      expect(entry.user_prompt.length).toBeGreaterThan(0);

      expect(typeof entry.retrieved_context).toBe('string');
      expect(entry.retrieved_context.length).toBeGreaterThan(0);

      expect(typeof entry.ideal_answer).toBe('string');
      expect(entry.ideal_answer.length).toBeGreaterThan(0);

      expect(Array.isArray(entry.expected_chunk_ids)).toBe(true);
    }
  });

  it('has at least 5 entries to support the PR mini-eval gate', () => {
    expect(entries.length).toBeGreaterThanOrEqual(5);
  });
});
