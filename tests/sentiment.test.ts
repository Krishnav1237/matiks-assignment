import { describe, it, expect } from 'vitest';
import { analyzeSentiment } from '../src/pipeline/sentiment';

describe('Sentiment Analysis (Sentiment + Social Lexicon)', () => {
  it('should handle basic positive text', () => {
    const result = analyzeSentiment('I love this product!');
    expect(result.label).toBe('positive');
    expect(result.score).toBeGreaterThan(0);
  });

  it('should handle basic negative text', () => {
    const result = analyzeSentiment('This is terrible and I hate it.');
    expect(result.label).toBe('negative');
    expect(result.score).toBeLessThan(0);
  });

  it('should handle neutral text', () => {
    const result = analyzeSentiment('The box is square.');
    expect(result.label).toBe('neutral');
  });

  it('should handle emojis correctly (social media context)', () => {
    const result = analyzeSentiment('This is fire 🔥🔥🔥');
    expect(result.label).toBe('positive');
    expect(result.score).toBeGreaterThan(0.1); 
  });
  
  it('should handle slang/informal text', () => {
    const result = analyzeSentiment('this crypto is a rug pull scam');
    expect(result.label).toBe('negative');
  });

  it('scrolls past neutral noise', () => {
    const result = analyzeSentiment('just a random update');
    expect(result.label).toBe('neutral');
  });
});
