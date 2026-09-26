// Unit tests for the usage-guide section splitter (pure, no disk access).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSections, matchSections, slugify } from '../src/lib/doc-sections.js';

const DOC = `# figma-ds-cli

Intro text that belongs to no topic.

## Quick Reference

| a | b |

## JSX Syntax (render command)

Use <Frame>.

### Nested heading stays here

More JSX detail.

## Critical Pitfalls

Don't do that.

## Design Tokens

tokens

## Token Hygiene (keep context lean)

hygiene
`;

test('splits on ## and keeps ### inside its parent section', () => {
  const sections = parseSections(DOC);
  assert.deepEqual(sections.map((s) => s.heading), [
    'Quick Reference',
    'JSX Syntax (render command)',
    'Critical Pitfalls',
    'Design Tokens',
    'Token Hygiene (keep context lean)',
  ]);
  const jsx = sections.find((s) => s.slug === 'jsx-syntax');
  assert.ok(jsx.body.includes('### Nested heading stays here'));
  assert.ok(jsx.body.includes('More JSX detail.'));
});

test('text before the first ## is dropped', () => {
  const joined = parseSections(DOC).map((s) => s.body).join('');
  assert.ok(!joined.includes('Intro text that belongs to no topic.'));
});

test('slugify drops parenthetical asides', () => {
  assert.equal(slugify('JSX Syntax (render command)'), 'jsx-syntax');
  assert.equal(slugify('Motion (Figma Animation, Config 2026 Beta)'), 'motion');
});

test('a single word matches the section it names', () => {
  const hits = matchSections(parseSections(DOC), 'jsx');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].heading, 'JSX Syntax (render command)');
});

test('a partial word still matches', () => {
  const hits = matchSections(parseSections(DOC), 'pitfall');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].heading, 'Critical Pitfalls');
});

test('an ambiguous query returns every candidate rather than guessing', () => {
  const hits = matchSections(parseSections(DOC), 'token');
  assert.deepEqual(hits.map((s) => s.heading), ['Design Tokens', 'Token Hygiene (keep context lean)']);
});

test('an exact slug beats the sections that merely contain it', () => {
  const hits = matchSections(parseSections(DOC), 'design-tokens');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].heading, 'Design Tokens');
});

test('an unknown query matches nothing', () => {
  assert.deepEqual(matchSections(parseSections(DOC), 'kubernetes'), []);
});

test('an empty query matches nothing', () => {
  assert.deepEqual(matchSections(parseSections(DOC), ''), []);
});

test('each section carries a token estimate', () => {
  const quick = parseSections(DOC).find((s) => s.slug === 'quick-reference');
  assert.ok(quick.tokens > 0);
  assert.equal(quick.tokens, Math.round(quick.body.length / 4));
});
