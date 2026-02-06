import Sentiment from 'sentiment';
import { socialLexicon } from './lexicon.js';

const analyzer = new Sentiment();

export interface SentimentResult {
  score: number;      // -1 to 1
  label: 'positive' | 'neutral' | 'negative';
  confidence: number; // 0 to 1
}

export function analyzeSentiment(text: string | null | undefined): SentimentResult {
  if (!text || text.trim().length === 0) {
    return { score: 0, label: 'neutral', confidence: 0 };
  }
  
  // Pass socialLexicon as 'extras' to override/extend standard AFINN
  const result = analyzer.analyze(text, { extras: socialLexicon });
  
  // Normalize comparative score (-5 to 5 usually, comparative is avg per word)
  // We want to clamp it between -1 and 1 strictly for our DB
  // result.comparative is already average score/word (approx -1 to 1 range usually)
  let normalized = result.comparative;
  
  // Adjust for high intensity but low word count (e.g. "Create!")
  if (result.score > 5) normalized = 1;
  else if (result.score < -5) normalized = -1;
  
  let label: 'positive' | 'neutral' | 'negative';
  if (normalized >= 0.1) {
    label = 'positive';
  } else if (normalized <= -0.1) {
    label = 'negative';
  } else {
    label = 'neutral';
  }
  
  return {
    score: Number(normalized.toFixed(3)),
    label,
    confidence: Math.min(1, Math.abs(normalized) + (result.tokens.length * 0.05)), // Heuristic
  };
}

// Batch analyze
export function analyzeSentimentBatch(texts: (string | null | undefined)[]): SentimentResult[] {
  return texts.map(text => analyzeSentiment(text));
}
