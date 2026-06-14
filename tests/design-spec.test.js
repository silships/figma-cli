import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseComponentSpecs, findComponentSpec, checkConformance } from '../src/lib/design-spec.js';

const MD = `# DESIGN.md -- Demo

## 6. Components

### Button

Page: Buttons · 12 variants

| Property | Values |
|---|---|
| Variant | Primary, Secondary, Danger, Invisible |
| Size | Small, Medium, Large |

Sample variant structure:

- **Variant=Primary, Size=Medium** · \`COMPONENT\` · 71×32 · horizontal row, gap 8px, padding 6/12/6/12px · 1 children
  - **Text** · \`TEXT\` · 45×17 · "Button"

### Avatar

Page: Avatars · 16 variants

| Property | Values |
|---|---|
| size | 16px, 24px, 32px |
| square | false, true |

Sample variant structure:

- **size=32px, square=false** · \`COMPONENT\` · 32×32 · 1 children
`;

describe('parseComponentSpecs', () => {
  it('parses each component block with axes and sample', () => {
    const specs = parseComponentSpecs(MD);
    assert.strictEqual(specs.length, 2);
    const btn = specs.find(s => s.name === 'Button');
    assert.strictEqual(btn.variants, 12);
    assert.deepStrictEqual(btn.axes.Variant, ['Primary', 'Secondary', 'Danger', 'Invisible']);
    assert.deepStrictEqual(btn.axes.Size, ['Small', 'Medium', 'Large']);
    assert.deepStrictEqual(btn.sample, { name: 'Variant=Primary, Size=Medium', type: 'COMPONENT', w: 71, h: 32, padding: '6/12/6/12px' });
  });

  it('ignores blocks without a variant count', () => {
    const specs = parseComponentSpecs('## 6. Components\n\n### NotAComponent\n\njust prose, no variants line\n');
    assert.strictEqual(specs.length, 0);
  });
});

describe('findComponentSpec', () => {
  it('matches case-insensitively and by substring', () => {
    assert.strictEqual(findComponentSpec(MD, 'button').name, 'Button');
    assert.strictEqual(findComponentSpec(MD, 'avat').name, 'Avatar');
    assert.strictEqual(findComponentSpec(MD, 'nope'), null);
  });
});

describe('checkConformance (hard rules)', () => {
  const spec = findComponentSpec(MD, 'Button');

  it('PASS when built as a COMPONENT_SET with matching axes and height', () => {
    const measured = {
      type: 'COMPONENT_SET',
      variantProps: ['Variant', 'Size'],
      variants: [{ name: 'Variant=Primary, Size=Medium', w: 71, h: 32 }],
    };
    const { pass, rules } = checkConformance(spec, measured);
    assert.ok(pass, JSON.stringify(rules));
  });

  it('FAILS when a multi-variant component is built as a single node', () => {
    const measured = { type: 'COMPONENT', variants: [{ name: 'Button', w: 71, h: 32 }] };
    const { pass, rules } = checkConformance(spec, measured);
    assert.ok(!pass);
    assert.ok(rules.some(r => !r.ok && /COMPONENT_SET/.test(r.msg)));
  });

  it('FAILS on wrong height ("zu hoch"), independent of axis order', () => {
    const measured = {
      type: 'COMPONENT_SET',
      variantProps: ['Size', 'Variant'],
      variants: [{ name: 'Size=Medium, Variant=Primary', w: 71, h: 100 }],
    };
    const { pass, rules } = checkConformance(spec, measured);
    assert.ok(!pass);
    assert.ok(rules.some(r => !r.ok && /height/.test(r.msg) && /100/.test(r.msg)));
  });

  it('does not fail on width differences (content-hug)', () => {
    const measured = {
      type: 'COMPONENT_SET',
      variantProps: ['Variant', 'Size'],
      variants: [{ name: 'Variant=Primary, Size=Medium', w: 90, h: 32 }],
    };
    const { pass } = checkConformance(spec, measured);
    assert.ok(pass, 'width drift alone must not fail the build');
  });
});
