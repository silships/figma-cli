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

Sample variant structure:

- **size=32px** · \`COMPONENT\` · 32×32 · 1 children
`;

describe('parseComponentSpecs (tree)', () => {
  it('parses axes and a full sample tree', () => {
    const specs = parseComponentSpecs(MD);
    assert.strictEqual(specs.length, 2);
    const btn = specs.find(s => s.name === 'Button');
    assert.strictEqual(btn.variants, 12);
    assert.deepStrictEqual(btn.axes.Size, ['Small', 'Medium', 'Large']);
    assert.strictEqual(btn.sample.name, 'Variant=Primary, Size=Medium');
    assert.strictEqual(btn.sample.lm, 'HORIZONTAL');
    assert.strictEqual(btn.sample.gap, 8);
    assert.deepStrictEqual(btn.sample.pad, [6, 12, 6, 12]);
    assert.strictEqual(btn.sample.children.length, 1);
    assert.strictEqual(btn.sample.children[0].type, 'TEXT');
    assert.strictEqual(btn.sample.children[0].h, 17);
  });

  it('ignores blocks without a variant count', () => {
    const specs = parseComponentSpecs('## 6. Components\n\n### Nope\n\njust prose\n');
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

describe('checkConformance (hard, deep)', () => {
  const spec = findComponentSpec(MD, 'Button');
  const goodTree = {
    name: 'Variant=Primary, Size=Medium', type: 'COMPONENT', w: 71, h: 32,
    lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12],
    children: [{ name: 'Label', type: 'TEXT', w: 45, h: 17 }],
  };
  const setOf = (tree) => ({ type: 'COMPONENT_SET', variantProps: ['Variant', 'Size'],
    variants: [{ name: tree.name, w: tree.w, h: tree.h }], sampleTree: tree });

  it('PASS when structure, axes, layout, gap, padding and children all match', () => {
    const { pass, rules } = checkConformance(spec, setOf(goodTree));
    assert.ok(pass, JSON.stringify(rules.filter(r => !r.ok)));
  });

  it('FAILS on wrong padding (a real md instruction)', () => {
    const { pass, rules } = checkConformance(spec, setOf({ ...goodTree, pad: [8, 8, 8, 8] }));
    assert.ok(!pass && rules.some(r => !r.ok && /padding/.test(r.msg)));
  });

  it('FAILS on wrong layout direction', () => {
    const { pass, rules } = checkConformance(spec, setOf({ ...goodTree, lm: 'VERTICAL' }));
    assert.ok(!pass && rules.some(r => !r.ok && /layout/.test(r.msg)));
  });

  it('FAILS on wrong gap', () => {
    const { pass, rules } = checkConformance(spec, setOf({ ...goodTree, gap: 4 }));
    assert.ok(!pass && rules.some(r => !r.ok && /gap/.test(r.msg)));
  });

  it('FAILS on wrong child count', () => {
    const { pass, rules } = checkConformance(spec, setOf({ ...goodTree, children: [] }));
    assert.ok(!pass && rules.some(r => !r.ok && /children/.test(r.msg)));
  });

  it('FAILS when a multi-variant component is built as a single node', () => {
    const measured = { type: 'COMPONENT', variants: [{ name: 'Button', w: 71, h: 32 }], sampleTree: goodTree };
    const { pass, rules } = checkConformance(spec, measured);
    assert.ok(!pass && rules.some(r => !r.ok && /COMPONENT_SET/.test(r.msg)));
  });

  it('does not fail on width differences (content-hug)', () => {
    const wide = { ...goodTree, w: 120, children: [{ name: 'Label', type: 'TEXT', w: 90, h: 17 }] };
    const { pass } = checkConformance(spec, setOf(wide));
    assert.ok(pass, 'width drift alone must not fail');
  });

  it('treats INSTANCE/FRAME as the same container class (no false fail)', () => {
    const { pass } = checkConformance(spec, setOf({ ...goodTree, type: 'FRAME' }));
    assert.ok(pass);
  });
});

describe('checkConformance severity (hints vs hard rules)', () => {
  const md = `## 6. Components

### Field

Page: Forms · 4 variants

| Property | Values |
|---|---|
| state | rest, focus |

Sample variant structure:

- **state=rest** · \`COMPONENT\` · 92×20 · horizontal row, gap 8px · 1 children
  - **LabelGroup** · \`FRAME\` · 68×20 · vertical stack, gap 4px · 2 children
    - **Label** · \`INSTANCE\` · 68×20 · horizontal row, gap 2px · instance of Label
    - **Caption** · \`INSTANCE\` · 69×20 · vertical stack · instance of Caption
`;
  const spec = findComponentSpec(md, 'Field');

  it('an INSTANCE built as raw TEXT is a HINT, not a failure', () => {
    const built = {
      type: 'COMPONENT_SET', variantProps: ['state'], variants: [{ name: 'state=rest', w: 92, h: 20 }],
      sampleTree: { name: 'state=rest', type: 'COMPONENT', w: 92, h: 20, lm: 'HORIZONTAL', gap: 8, children: [
        { name: 'LabelGroup', type: 'FRAME', w: 68, h: 40, lm: 'VERTICAL', gap: 4, children: [
          { name: 'Label', type: 'TEXT', w: 68, h: 20 },
          { name: 'Caption', type: 'TEXT', w: 69, h: 20 },
        ] },
      ] },
    };
    const { pass, rules } = checkConformance(spec, built);
    assert.ok(pass, 'composition hints + non-physical dims must not fail the build');
    assert.ok(rules.some(r => r.warn && /Consider instancing/.test(r.msg)), 'should hint to instance the component');
    assert.ok(rules.some(r => r.warn && /non-physical/.test(r.msg)), 'should flag the 20px-vs-40px group as non-physical');
  });

  it('a genuine structural error (TEXT where spec wants TEXT-less container mismatch) still fails', () => {
    const built = {
      type: 'COMPONENT_SET', variantProps: ['state'], variants: [{ name: 'state=rest', w: 92, h: 20 }],
      sampleTree: { name: 'state=rest', type: 'COMPONENT', w: 92, h: 20, lm: 'HORIZONTAL', gap: 8, children: [
        { name: 'LabelGroup', type: 'TEXT', w: 68, h: 20 },  // spec wants a FRAME container here
      ] },
    };
    const { pass } = checkConformance(spec, built);
    assert.ok(!pass, 'a FRAME built as TEXT is a real failure');
  });
});

describe('content lists (×N repeats)', () => {
  const md = `## 6. Components

### Menu

Page: Menus · 2 variants

| Property | Values |
|---|---|
| kind | a, b |

Sample variant structure:

- **kind=a** · \`COMPONENT\` · 240×400 · vertical stack · 5 children
  - **Heading** · \`INSTANCE\` · 240×34 · horizontal row, gap 8px · instance of Heading
  - **Item** · \`INSTANCE\` · 240×32 · horizontal row, gap 8px, padding 6/8/6/8px · instance of Item · ×6
  - **Divider** · \`INSTANCE\` · 240×16 · vertical stack, gap 8px · instance of Divider
  - **Item** · \`INSTANCE\` · 240×32 · horizontal row, gap 8px, padding 6/8/6/8px · instance of Item · ×3
`;
  const spec = findComponentSpec(md, 'Menu');

  it('parses the ×N repeat marker', () => {
    const item = spec.sample.children.find(c => c.name === 'Item');
    assert.strictEqual(item.repeat, 6);
  });

  it('a shorter list with the same item types still PASSES (count/height advisory)', () => {
    const built = {
      type: 'COMPONENT_SET', variantProps: ['kind'], variants: [{ name: 'kind=a', w: 240, h: 150 }],
      sampleTree: { name: 'kind=a', type: 'COMPONENT', w: 240, h: 150, lm: 'VERTICAL', children: [
        { name: 'Heading', type: 'FRAME', w: 240, h: 34, lm: 'HORIZONTAL', gap: 8 },
        { name: 'Item', type: 'FRAME', w: 240, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 8, 6, 8] },
        { name: 'Item', type: 'FRAME', w: 240, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 8, 6, 8] },
      ] },
    };
    const { pass, rules } = checkConformance(spec, built);
    assert.ok(pass, JSON.stringify(rules.filter(r => !r.ok && !r.warn)));
    assert.ok(rules.some(r => r.warn && /content list/.test(r.msg)));
  });

  it('wrong padding on an INSTANCE item is an advisory hint (instance the component)', () => {
    // Item is an INSTANCE in the spec, so its internal padding is advisory —
    // the right fix is to instance the sub-component, which gets it right.
    const built = {
      type: 'COMPONENT_SET', variantProps: ['kind'], variants: [{ name: 'kind=a', w: 240, h: 150 }],
      sampleTree: { name: 'kind=a', type: 'COMPONENT', w: 240, h: 150, lm: 'VERTICAL', children: [
        { name: 'Heading', type: 'FRAME', w: 240, h: 34, lm: 'HORIZONTAL', gap: 8 },
        { name: 'Item', type: 'FRAME', w: 240, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [12, 12, 12, 12] },
      ] },
    };
    const { pass, rules } = checkConformance(spec, built);
    assert.ok(pass, 'instance-internal padding is a hint, not a hard fail');
    assert.ok(rules.some(r => r.warn && /padding/.test(r.msg) && /instance internal/.test(r.msg)));
  });

  it('a missing item TYPE (not built at all) is flagged', () => {
    const built = {
      type: 'COMPONENT_SET', variantProps: ['kind'], variants: [{ name: 'kind=a', w: 240, h: 80 }],
      sampleTree: { name: 'kind=a', type: 'COMPONENT', w: 240, h: 80, lm: 'VERTICAL', children: [
        { name: 'Item', type: 'FRAME', w: 240, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 8, 6, 8] },
      ] },  // no Heading, no Divider built
    };
    const { rules } = checkConformance(spec, built);
    assert.ok(rules.some(r => /no matching item built/.test(r.msg)), 'should note the Heading/Divider item types were not built');
  });
});
