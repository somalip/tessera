export interface Snippet {
  path: string;
  text: string;
}

function words(text: string): string[] {
  return (text.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? [])
    .filter(word => word.length > 1).map(word => word.toLowerCase());
}

export class BM25 {
  private readonly documents: { snippet: Snippet; frequency: Map<string, number>; length: number }[];
  private readonly counts = new Map<string, number>();
  private readonly averageLength: number;

  constructor(snippets: Snippet[]) {
    this.documents = snippets.map(snippet => {
      const terms = words(snippet.path + "\n" + snippet.text);
      const frequency = new Map<string, number>();
      for (const word of terms) frequency.set(word, (frequency.get(word) ?? 0) + 1);
      for (const word of frequency.keys()) this.counts.set(word, (this.counts.get(word) ?? 0) + 1);
      return { snippet, frequency, length: terms.length };
    });
    this.averageLength = this.documents.reduce((sum, doc) => sum + doc.length, 0) /
      Math.max(1, this.documents.length) || 1;
  }

  search(query: string, omitPath: string, limit = 3): Snippet[] {
    const terms = [...new Set(words(query))].slice(-80);
    return this.documents.filter(doc => doc.snippet.path !== omitPath).map(doc => {
      const normalization = 1.2 * (0.25 + 0.75 * doc.length / this.averageLength);
      let score = 0;
      for (const word of terms) {
        const count = this.counts.get(word) ?? 0;
        const frequency = doc.frequency.get(word) ?? 0;
        const weight = Math.log(1 + (this.documents.length - count + 0.5) / (count + 0.5));
        score += weight * frequency * 2.2 / (frequency + normalization);
      }
      return { snippet: doc.snippet, score };
    }).filter(result => result.score > 0).sort((a, b) => b.score - a.score)
      .slice(0, limit).map(result => result.snippet);
  }
}
