/**
 * shadcn/ui Component Generator for Figma
 *
 * Generates Figma components matching official shadcn/ui specs.
 * Based on the public registry at ui.shadcn.com.
 * Requires shadcn tokens: `node src/index.js tokens preset shadcn`
 *
 * Uses real Lucide icons via <Icon name="lucide:icon-name" /> syntax.
 * Icons are fetched from Iconify API and rendered as SVG nodes in Figma.
 *
 * Tailwind class mapping:
 *   h-10 = 40px, h-9 = 36px, h-11 = 44px
 *   px-4 = 16px, px-3 = 12px, px-8 = 32px, py-2 = 8px
 *   p-6 = 24px, p-4 = 16px
 *   rounded-md = 6px, rounded-lg = 8px, rounded-full = 9999px
 *   text-sm = 14px, text-xs = 12px, text-2xl = 24px
 *   space-y-1.5 = gap 6px
 *   px-2.5 = 10px, py-0.5 = 2px
 */

const components = {

  // ── Button ──────────────────────────────────────────────────────────
  // Base: inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium
  // Variants: default, secondary, destructive, outline, ghost, link
  // Sizes: default (h-10 px-4 py-2), sm (h-9 px-3), lg (h-11 px-8), icon (h-10 w-10)
  button: () => {
    const btn = (name, h, px, rounded, bg, fg) =>
      `<Frame name="${name}" h={${h}} bg="${bg}" rounded={${rounded}} flex="row" justify="center" items="center" gap={8} px={${px}} py={8}><Text size={14} weight="medium" color="${fg}">Button</Text></Frame>`;
    return [
      { name: 'Button / Default', jsx: btn('Button / Default', 40, 16, 6, 'var:primary', 'var:primary-foreground') },
      { name: 'Button / Secondary', jsx: btn('Button / Secondary', 40, 16, 6, 'var:secondary', 'var:secondary-foreground') },
      { name: 'Button / Destructive', jsx: btn('Button / Destructive', 40, 16, 6, 'var:destructive', 'var:destructive-foreground') },
      { name: 'Button / Outline', jsx: `<Frame name="Button / Outline" h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" justify="center" items="center" gap={8} px={16} py={8}><Text size={14} weight="medium" color="var:foreground">Button</Text></Frame>` },
      { name: 'Button / Ghost', jsx: `<Frame name="Button / Ghost" h={40} rounded={6} flex="row" justify="center" items="center" gap={8} px={16} py={8}><Text size={14} weight="medium" color="var:foreground">Button</Text></Frame>` },
      { name: 'Button / Link', jsx: `<Frame name="Button / Link" h={40} rounded={6} flex="row" justify="center" items="center" gap={8} px={16} py={8}><Text size={14} weight="medium" color="var:primary">Button</Text></Frame>` },
      { name: 'Button / Small', jsx: btn('Button / Small', 36, 12, 6, 'var:primary', 'var:primary-foreground') },
      { name: 'Button / Large', jsx: btn('Button / Large', 44, 32, 6, 'var:primary', 'var:primary-foreground') },
      { name: 'Button / Icon', jsx: `<Frame name="Button / Icon" w={40} h={40} bg="var:primary" rounded={6} flex="row" justify="center" items="center"><Icon name="lucide:plus" size={16} color="var:primary-foreground" /></Frame>` },
    ];
  },

  // ── Badge ───────────────────────────────────────────────────────────
  // Base: inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold
  badge: () => [
    { name: 'Badge / Default', jsx: `<Frame name="Badge / Default" bg="var:primary" rounded={9999} flex="row" items="center" px={10} py={2}><Text size={12} weight="semibold" color="var:primary-foreground">Badge</Text></Frame>` },
    { name: 'Badge / Secondary', jsx: `<Frame name="Badge / Secondary" bg="var:secondary" rounded={9999} flex="row" items="center" px={10} py={2}><Text size={12} weight="semibold" color="var:secondary-foreground">Badge</Text></Frame>` },
    { name: 'Badge / Destructive', jsx: `<Frame name="Badge / Destructive" bg="var:destructive" rounded={9999} flex="row" items="center" px={10} py={2}><Text size={12} weight="semibold" color="var:destructive-foreground">Badge</Text></Frame>` },
    { name: 'Badge / Outline', jsx: `<Frame name="Badge / Outline" rounded={9999} flex="row" items="center" px={10} py={2} stroke="var:border" strokeWidth={1}><Text size={12} weight="semibold" color="var:foreground">Badge</Text></Frame>` },
  ],

  // ── Card ─────────────────────────────────────────────────────────────
  card: () => [
    { name: 'Card', jsx: `<Frame name="Card" w={350} flex="col" bg="var:card" stroke="var:border" strokeWidth={1} rounded={8} shadow="0px 1px 2px rgba(0,0,0,0.05)"><Frame name="CardHeader" flex="col" gap={6} p={24} w="fill"><Text size={24} weight="semibold" color="var:card-foreground" w="fill">Card Title</Text><Text size={14} color="var:muted-foreground" w="fill">Card description goes here.</Text></Frame><Frame name="CardContent" flex="col" gap={8} px={24} pb={24} w="fill"><Text size={14} color="var:card-foreground" w="fill">Your content goes here. Add any components or text.</Text></Frame><Frame name="CardFooter" flex="row" items="center" gap={8} px={24} pb={24} w="fill" justify="start"><Frame bg="var:primary" px={16} py={8} rounded={6} flex="row" justify="center" items="center"><Text size={14} weight="medium" color="var:primary-foreground">Save</Text></Frame><Frame bg="var:background" stroke="var:input" strokeWidth={1} px={16} py={8} rounded={6} flex="row" justify="center" items="center"><Text size={14} weight="medium" color="var:foreground">Cancel</Text></Frame></Frame></Frame>` },
  ],

  // ── Input ────────────────────────────────────────────────────────────
  input: () => [
    { name: 'Input / Default', jsx: `<Frame name="Input / Default" w={280} h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12}><Text size={14} color="var:muted-foreground">Email</Text></Frame>` },
    { name: 'Input / Filled', jsx: `<Frame name="Input / Filled" w={280} h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12}><Text size={14} color="var:foreground">john@example.com</Text></Frame>` },
    { name: 'Input / With Label', jsx: `<Frame name="Input / With Label" w={280} flex="col" gap={8}><Text size={14} weight="medium" color="var:foreground">Email</Text><Frame w="fill" h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12}><Text size={14} color="var:muted-foreground">m@example.com</Text></Frame></Frame>` },
  ],

  // ── Textarea ─────────────────────────────────────────────────────────
  textarea: () => [
    { name: 'Textarea', jsx: `<Frame name="Textarea" w={280} h={80} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="col" p={12} pt={8}><Text size={14} color="var:muted-foreground" w="fill">Type your message here.</Text></Frame>` },
  ],

  // ── Label ────────────────────────────────────────────────────────────
  label: () => [
    { name: 'Label', jsx: `<Frame name="Label" flex="row"><Text size={14} weight="medium" color="var:foreground">Label</Text></Frame>` },
  ],

  // ── Alert ────────────────────────────────────────────────────────────
  alert: () => [
    { name: 'Alert / Default', jsx: `<Frame name="Alert / Default" w={400} flex="row" bg="var:background" stroke="var:border" strokeWidth={1} rounded={8} p={16} gap={12} items="start"><Icon name="lucide:info" size={16} color="var:foreground" /><Frame flex="col" gap={4} w="fill"><Text size={14} weight="medium" color="var:foreground" w="fill">Heads up!</Text><Text size={14} color="var:muted-foreground" w="fill">You can add components to your app using the CLI.</Text></Frame></Frame>` },
    { name: 'Alert / Destructive', jsx: `<Frame name="Alert / Destructive" w={400} flex="row" bg="var:background" stroke="var:destructive" strokeWidth={1} rounded={8} p={16} gap={12} items="start"><Icon name="lucide:alert-circle" size={16} color="var:destructive" /><Frame flex="col" gap={4} w="fill"><Text size={14} weight="medium" color="var:destructive" w="fill">Error</Text><Text size={14} color="var:muted-foreground" w="fill">Your session has expired. Please log in again.</Text></Frame></Frame>` },
  ],

  // ── Avatar ───────────────────────────────────────────────────────────
  avatar: () => [
    { name: 'Avatar / Default', jsx: `<Frame name="Avatar / Default" w={40} h={40} bg="var:muted" rounded={9999} flex="row" justify="center" items="center"><Text size={16} weight="medium" color="var:muted-foreground">CN</Text></Frame>` },
    { name: 'Avatar / Small', jsx: `<Frame name="Avatar / Small" w={32} h={32} bg="var:muted" rounded={9999} flex="row" justify="center" items="center"><Text size={12} weight="medium" color="var:muted-foreground">CN</Text></Frame>` },
  ],

  // ── Switch ──────────────────────────────────────────────────────────
  switch: () => [
    { name: 'Switch / On', jsx: `<Frame name="Switch / On" w={44} h={24} bg="var:primary" rounded={9999} flex="row" items="center" p={2} justify="end"><Frame w={20} h={20} bg="var:primary-foreground" rounded={9999} /></Frame>` },
    { name: 'Switch / Off', jsx: `<Frame name="Switch / Off" w={44} h={24} bg="var:input" rounded={9999} flex="row" items="center" p={2} justify="start"><Frame w={20} h={20} bg="var:background" rounded={9999} /></Frame>` },
  ],

  // ── Separator ───────────────────────────────────────────────────────
  separator: () => [
    { name: 'Separator / Horizontal', jsx: `<Frame name="Separator / Horizontal" w={280} h={1} bg="var:border" />` },
    { name: 'Separator / Vertical', jsx: `<Frame name="Separator / Vertical" w={1} h={40} bg="var:border" />` },
  ],

  // ── Skeleton ────────────────────────────────────────────────────────
  skeleton: () => [
    { name: 'Skeleton / Text', jsx: `<Frame name="Skeleton / Text" w={200} h={16} bg="var:muted" rounded={6} />` },
    { name: 'Skeleton / Circle', jsx: `<Frame name="Skeleton / Circle" w={40} h={40} bg="var:muted" rounded={9999} />` },
    { name: 'Skeleton / Card', jsx: `<Frame name="Skeleton / Card" w={350} flex="col" gap={12} p={24}><Frame flex="row" gap={16} items="center" w="fill"><Frame w={48} h={48} bg="var:muted" rounded={9999} /><Frame flex="col" gap={8} w="fill"><Frame w={200} h={16} bg="var:muted" rounded={6} /><Frame w={140} h={14} bg="var:muted" rounded={6} /></Frame></Frame><Frame w="fill" h={14} bg="var:muted" rounded={6} /><Frame w="fill" h={14} bg="var:muted" rounded={6} /><Frame w={200} h={14} bg="var:muted" rounded={6} /></Frame>` },
  ],

  // ── Progress ────────────────────────────────────────────────────────
  progress: () => [
    { name: 'Progress / 60%', jsx: `<Frame name="Progress / 60%" w={280} h={8} bg="var:secondary" rounded={9999} overflow="hidden"><Frame w={168} h={8} bg="var:primary" rounded={9999} /></Frame>` },
    { name: 'Progress / 30%', jsx: `<Frame name="Progress / 30%" w={280} h={8} bg="var:secondary" rounded={9999} overflow="hidden"><Frame w={84} h={8} bg="var:primary" rounded={9999} /></Frame>` },
  ],

  // ── Toggle ──────────────────────────────────────────────────────────
  toggle: () => [
    { name: 'Toggle / Default', jsx: `<Frame name="Toggle / Default" w={40} h={40} rounded={6} flex="row" justify="center" items="center"><Icon name="lucide:bold" size={16} color="var:foreground" /></Frame>` },
    { name: 'Toggle / Active', jsx: `<Frame name="Toggle / Active" w={40} h={40} bg="var:accent" rounded={6} flex="row" justify="center" items="center"><Icon name="lucide:bold" size={16} color="var:accent-foreground" /></Frame>` },
  ],

  // ── Checkbox ────────────────────────────────────────────────────────
  checkbox: () => [
    { name: 'Checkbox / Unchecked', jsx: `<Frame name="Checkbox / Unchecked" w={16} h={16} bg="var:background" stroke="var:primary" strokeWidth={1} rounded={4} />` },
    { name: 'Checkbox / Checked', jsx: `<Frame name="Checkbox / Checked" w={16} h={16} bg="var:primary" rounded={4} flex="row" justify="center" items="center"><Icon name="lucide:check" size={12} color="var:primary-foreground" /></Frame>` },
  ],

  // ── Tabs ─────────────────────────────────────────────────────────────
  tabs: () => [
    { name: 'Tabs', jsx: `<Frame name="Tabs" w={400} flex="col" gap={8}><Frame name="TabsList" w="fill" h={40} bg="var:muted" rounded={6} flex="row" p={4} gap={4}><Frame name="Tab Active" bg="var:background" rounded={4} flex="row" justify="center" items="center" grow={1} shadow="0px 1px 2px rgba(0,0,0,0.05)"><Text size={14} weight="medium" color="var:foreground">Account</Text></Frame><Frame name="Tab Inactive" rounded={4} flex="row" justify="center" items="center" grow={1}><Text size={14} color="var:muted-foreground">Password</Text></Frame></Frame><Frame name="TabContent" w="fill" bg="var:card" stroke="var:border" strokeWidth={1} rounded={8} p={24} flex="col" gap={16}><Frame flex="col" gap={4} w="fill"><Text size={18} weight="semibold" color="var:card-foreground" w="fill">Account</Text><Text size={14} color="var:muted-foreground" w="fill">Make changes to your account here.</Text></Frame><Frame flex="col" gap={8} w="fill"><Text size={14} weight="medium" color="var:foreground">Name</Text><Frame w="fill" h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12}><Text size={14} color="var:foreground">Pedro Duarte</Text></Frame></Frame><Frame bg="var:primary" px={16} py={8} rounded={6} flex="row" justify="center" items="center"><Text size={14} weight="medium" color="var:primary-foreground">Save changes</Text></Frame></Frame></Frame>` },
  ],

  // ── Table ────────────────────────────────────────────────────────────
  table: () => [
    { name: 'Table', jsx: `<Frame name="Table" w={500} flex="col" bg="var:card" stroke="var:border" strokeWidth={1} rounded={8} overflow="hidden"><Frame name="Header" w="fill" flex="row" bg="var:muted" px={16} h={48} items="center"><Frame w={200} flex="row"><Text size={14} weight="medium" color="var:muted-foreground">Invoice</Text></Frame><Frame w={100} flex="row"><Text size={14} weight="medium" color="var:muted-foreground">Status</Text></Frame><Frame grow={1} flex="row" justify="end"><Text size={14} weight="medium" color="var:muted-foreground">Amount</Text></Frame></Frame><Frame name="Row 1" w="fill" flex="row" px={16} h={48} items="center" stroke="var:border" strokeWidth={1} strokeAlign="inside"><Frame w={200} flex="row"><Text size={14} weight="medium" color="var:card-foreground">INV001</Text></Frame><Frame w={100} flex="row"><Text size={14} color="var:card-foreground">Paid</Text></Frame><Frame grow={1} flex="row" justify="end"><Text size={14} color="var:card-foreground">$250.00</Text></Frame></Frame><Frame name="Row 2" w="fill" flex="row" px={16} h={48} items="center" stroke="var:border" strokeWidth={1} strokeAlign="inside"><Frame w={200} flex="row"><Text size={14} weight="medium" color="var:card-foreground">INV002</Text></Frame><Frame w={100} flex="row"><Text size={14} color="var:card-foreground">Pending</Text></Frame><Frame grow={1} flex="row" justify="end"><Text size={14} color="var:card-foreground">$150.00</Text></Frame></Frame><Frame name="Row 3" w="fill" flex="row" px={16} h={48} items="center"><Frame w={200} flex="row"><Text size={14} weight="medium" color="var:card-foreground">INV003</Text></Frame><Frame w={100} flex="row"><Text size={14} color="var:card-foreground">Unpaid</Text></Frame><Frame grow={1} flex="row" justify="end"><Text size={14} color="var:card-foreground">$350.00</Text></Frame></Frame></Frame>` },
  ],

  // ── Radio Group ──────────────────────────────────────────────────────
  'radio-group': () => [
    { name: 'Radio / Unchecked', jsx: `<Frame name="Radio / Unchecked" w={16} h={16} stroke="var:primary" strokeWidth={1} rounded={9999} />` },
    { name: 'Radio / Checked', jsx: `<Frame name="Radio / Checked" w={16} h={16} stroke="var:primary" strokeWidth={1} rounded={9999} flex="row" justify="center" items="center"><Frame w={8} h={8} bg="var:primary" rounded={9999} /></Frame>` },
    { name: 'Radio Group', jsx: `<Frame name="Radio Group" flex="col" gap={12}><Frame flex="row" gap={8} items="center"><Frame w={16} h={16} stroke="var:primary" strokeWidth={1} rounded={9999} flex="row" justify="center" items="center"><Frame w={8} h={8} bg="var:primary" rounded={9999} /></Frame><Text size={14} color="var:foreground">Default</Text></Frame><Frame flex="row" gap={8} items="center"><Frame w={16} h={16} stroke="var:primary" strokeWidth={1} rounded={9999} /><Text size={14} color="var:foreground">Comfortable</Text></Frame><Frame flex="row" gap={8} items="center"><Frame w={16} h={16} stroke="var:primary" strokeWidth={1} rounded={9999} /><Text size={14} color="var:foreground">Compact</Text></Frame></Frame>` },
  ],

  // ── Select ──────────────────────────────────────────────────────────
  select: () => [
    { name: 'Select / Closed', jsx: `<Frame name="Select / Closed" w={200} h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12} gap={8}><Text size={14} color="var:muted-foreground">Select...</Text><Frame grow={1} /><Icon name="lucide:chevron-down" size={14} color="var:muted-foreground" /></Frame>` },
    { name: 'Select / Filled', jsx: `<Frame name="Select / Filled" w={200} h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12} gap={8}><Text size={14} color="var:foreground">Option A</Text><Frame grow={1} /><Icon name="lucide:chevron-down" size={14} color="var:muted-foreground" /></Frame>` },
    { name: 'Select / Open', jsx: `<Frame name="Select / Open" w={200} flex="col" gap={4}><Frame w="fill" h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12} gap={8}><Text size={14} color="var:foreground">Option A</Text><Frame grow={1} /><Icon name="lucide:chevron-up" size={14} color="var:muted-foreground" /></Frame><Frame w="fill" bg="var:card" stroke="var:border" strokeWidth={1} rounded={6} p={4} flex="col" shadow="0px 4px 12px rgba(0,0,0,0.1)"><Frame w="fill" h={32} bg="var:accent" rounded={4} flex="row" items="center" px={8} gap={8}><Icon name="lucide:check" size={14} color="var:accent-foreground" /><Text size={14} color="var:accent-foreground">Option A</Text></Frame><Frame w="fill" h={32} rounded={4} flex="row" items="center" px={8} pl={30}><Text size={14} color="var:card-foreground">Option B</Text></Frame><Frame w="fill" h={32} rounded={4} flex="row" items="center" px={8} pl={30}><Text size={14} color="var:card-foreground">Option C</Text></Frame></Frame></Frame>` },
  ],

  // ── Slider ──────────────────────────────────────────────────────────
  slider: () => [
    { name: 'Slider', jsx: `<Frame name="Slider" w={280} h={20} flex="row" items="center"><Frame w={168} h={8} bg="var:primary" roundedTL={9999} roundedBL={9999} /><Frame w={112} h={8} bg="var:secondary" roundedTR={9999} roundedBR={9999} /><Frame name="Thumb" w={20} h={20} bg="var:background" stroke="var:primary" strokeWidth={2} rounded={9999} position="absolute" x={158} /></Frame>` },
  ],

  // ── Breadcrumb ──────────────────────────────────────────────────────
  breadcrumb: () => [
    { name: 'Breadcrumb', jsx: `<Frame name="Breadcrumb" flex="row" gap={6} items="center"><Text size={14} color="var:muted-foreground">Home</Text><Icon name="lucide:chevron-right" size={14} color="var:muted-foreground" /><Text size={14} color="var:muted-foreground">Components</Text><Icon name="lucide:chevron-right" size={14} color="var:muted-foreground" /><Text size={14} weight="medium" color="var:foreground">Breadcrumb</Text></Frame>` },
  ],

  // ── Pagination ──────────────────────────────────────────────────────
  pagination: () => [
    { name: 'Pagination', jsx: `<Frame name="Pagination" flex="row" gap={4} items="center"><Frame w={40} h={40} rounded={6} stroke="var:input" strokeWidth={1} flex="row" justify="center" items="center"><Icon name="lucide:chevron-left" size={16} color="var:foreground" /></Frame><Frame w={40} h={40} bg="var:primary" rounded={6} flex="row" justify="center" items="center"><Text size={14} weight="medium" color="var:primary-foreground">1</Text></Frame><Frame w={40} h={40} rounded={6} flex="row" justify="center" items="center"><Text size={14} color="var:foreground">2</Text></Frame><Frame w={40} h={40} rounded={6} flex="row" justify="center" items="center"><Text size={14} color="var:foreground">3</Text></Frame><Frame w={40} h={40} rounded={6} flex="row" justify="center" items="center"><Icon name="lucide:ellipsis" size={16} color="var:muted-foreground" /></Frame><Frame w={40} h={40} rounded={6} stroke="var:input" strokeWidth={1} flex="row" justify="center" items="center"><Icon name="lucide:chevron-right" size={16} color="var:foreground" /></Frame></Frame>` },
  ],

  // ── Kbd ─────────────────────────────────────────────────────────────
  kbd: () => [
    { name: 'Kbd', jsx: `<Frame name="Kbd" flex="row" items="center" px={6} py={2} rounded={4} stroke="var:border" strokeWidth={1} bg="var:muted"><Text size={12} weight="medium" color="var:foreground">⌘K</Text></Frame>` },
    { name: 'Kbd / Large', jsx: `<Frame name="Kbd / Large" flex="row" items="center" gap={4}><Frame flex="row" items="center" px={6} py={2} rounded={4} stroke="var:border" strokeWidth={1} bg="var:muted"><Text size={12} weight="medium" color="var:foreground">⌘</Text></Frame><Frame flex="row" items="center" px={6} py={2} rounded={4} stroke="var:border" strokeWidth={1} bg="var:muted"><Text size={12} weight="medium" color="var:foreground">Shift</Text></Frame><Frame flex="row" items="center" px={6} py={2} rounded={4} stroke="var:border" strokeWidth={1} bg="var:muted"><Text size={12} weight="medium" color="var:foreground">P</Text></Frame></Frame>` },
  ],

  // ── Spinner ─────────────────────────────────────────────────────────
  spinner: () => [
    { name: 'Spinner / Small', jsx: `<Frame name="Spinner / Small" w={16} h={16} rounded={9999} stroke="var:primary" strokeWidth={2} />` },
    { name: 'Spinner / Medium', jsx: `<Frame name="Spinner / Medium" w={24} h={24} rounded={9999} stroke="var:primary" strokeWidth={2} />` },
  ],

  // ── Tooltip ─────────────────────────────────────────────────────────
  tooltip: () => [
    { name: 'Tooltip', jsx: `<Frame name="Tooltip" flex="col" items="center" gap={4}><Frame bg="var:primary" rounded={6} px={12} py={6} shadow="0px 4px 8px rgba(0,0,0,0.12)"><Text size={14} color="var:primary-foreground">Add to library</Text></Frame><Frame bg="var:primary" px={16} py={8} rounded={6} flex="row" justify="center" items="center"><Text size={14} weight="medium" color="var:primary-foreground">Hover me</Text></Frame></Frame>` },
  ],

  // ── Dialog ──────────────────────────────────────────────────────────
  dialog: () => [
    { name: 'Dialog', jsx: `<Frame name="Dialog" w={450} flex="col" bg="var:background" stroke="var:border" strokeWidth={1} rounded={8} p={24} gap={16} shadow="0px 8px 24px rgba(0,0,0,0.15)"><Frame flex="row" items="start" w="fill"><Frame flex="col" gap={6} w="fill"><Text size={18} weight="semibold" color="var:foreground" w="fill">Edit profile</Text><Text size={14} color="var:muted-foreground" w="fill">Make changes to your profile here. Click save when you are done.</Text></Frame><Frame w={24} h={24} rounded={4} flex="row" justify="center" items="center"><Icon name="lucide:x" size={16} color="var:muted-foreground" /></Frame></Frame><Frame flex="col" gap={12} w="fill"><Frame flex="col" gap={8} w="fill"><Text size={14} weight="medium" color="var:foreground">Name</Text><Frame w="fill" h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12}><Text size={14} color="var:foreground">Pedro Duarte</Text></Frame></Frame><Frame flex="col" gap={8} w="fill"><Text size={14} weight="medium" color="var:foreground">Username</Text><Frame w="fill" h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12}><Text size={14} color="var:foreground">@peduarte</Text></Frame></Frame></Frame><Frame flex="row" justify="end" w="fill"><Frame bg="var:primary" px={16} py={8} rounded={6} flex="row" justify="center" items="center"><Text size={14} weight="medium" color="var:primary-foreground">Save changes</Text></Frame></Frame></Frame>` },
  ],

  // ── Dropdown Menu ───────────────────────────────────────────────────
  'dropdown-menu': () => [
    { name: 'Dropdown Menu', jsx: `<Frame name="Dropdown Menu" w={200} bg="var:card" stroke="var:border" strokeWidth={1} rounded={6} p={4} flex="col" shadow="0px 4px 12px rgba(0,0,0,0.1)"><Frame w="fill" h={32} rounded={4} flex="row" items="center" px={8} bg="var:accent"><Text size={14} color="var:accent-foreground">Profile</Text></Frame><Frame w="fill" h={32} rounded={4} flex="row" items="center" px={8}><Text size={14} color="var:card-foreground">Billing</Text></Frame><Frame w="fill" h={32} rounded={4} flex="row" items="center" px={8}><Text size={14} color="var:card-foreground">Settings</Text></Frame><Frame w="fill" h={1} bg="var:border" /><Frame w="fill" h={32} rounded={4} flex="row" items="center" px={8}><Text size={14} color="var:card-foreground">Log out</Text></Frame></Frame>` },
  ],

  // ── Accordion ───────────────────────────────────────────────────────
  accordion: () => [
    { name: 'Accordion', jsx: `<Frame name="Accordion" w={400} flex="col" bg="var:background"><Frame name="Item Open" w="fill" flex="col" stroke="var:border" strokeWidth={1} strokeAlign="inside"><Frame w="fill" flex="row" items="center" px={0} py={16}><Text size={14} weight="medium" color="var:foreground" w="fill">Is it accessible?</Text><Icon name="lucide:chevron-down" size={16} color="var:muted-foreground" /></Frame><Frame w="fill" pb={16} flex="col"><Text size={14} color="var:muted-foreground" w="fill">Yes. It adheres to the WAI-ARIA design pattern.</Text></Frame></Frame><Frame name="Item Closed" w="fill" flex="row" items="center" py={16} stroke="var:border" strokeWidth={1} strokeAlign="inside"><Text size={14} weight="medium" color="var:foreground" w="fill">Is it styled?</Text><Icon name="lucide:chevron-right" size={16} color="var:muted-foreground" /></Frame><Frame name="Item Closed 2" w="fill" flex="row" items="center" py={16} stroke="var:border" strokeWidth={1} strokeAlign="inside"><Text size={14} weight="medium" color="var:foreground" w="fill">Is it animated?</Text><Icon name="lucide:chevron-right" size={16} color="var:muted-foreground" /></Frame></Frame>` },
  ],

  // ── Navigation Menu ─────────────────────────────────────────────────
  'navigation-menu': () => [
    { name: 'Navigation Menu', jsx: `<Frame name="Navigation Menu" flex="row" gap={4} items="center" bg="var:background" p={4} rounded={6}><Frame h={36} px={16} rounded={6} bg="var:accent" flex="row" items="center"><Text size={14} weight="medium" color="var:accent-foreground">Getting Started</Text></Frame><Frame h={36} px={16} rounded={6} flex="row" items="center" gap={4}><Text size={14} weight="medium" color="var:foreground">Components</Text><Icon name="lucide:chevron-down" size={12} color="var:muted-foreground" /></Frame><Frame h={36} px={16} rounded={6} flex="row" items="center"><Text size={14} weight="medium" color="var:foreground">Documentation</Text></Frame></Frame>` },
  ],

  // ── Sheet ───────────────────────────────────────────────────────────
  sheet: () => [
    { name: 'Sheet', jsx: `<Frame name="Sheet" w={380} h={500} bg="var:background" stroke="var:border" strokeWidth={1} p={24} flex="col" gap={16} shadow="0px 8px 24px rgba(0,0,0,0.15)"><Frame flex="row" items="start" w="fill"><Frame flex="col" gap={6} w="fill"><Text size={18} weight="semibold" color="var:foreground" w="fill">Edit profile</Text><Text size={14} color="var:muted-foreground" w="fill">Make changes to your profile here.</Text></Frame><Frame w={24} h={24} rounded={4} flex="row" justify="center" items="center"><Icon name="lucide:x" size={16} color="var:muted-foreground" /></Frame></Frame><Frame flex="col" gap={12} w="fill"><Frame flex="col" gap={8} w="fill"><Text size={14} weight="medium" color="var:foreground">Name</Text><Frame w="fill" h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12}><Text size={14} color="var:foreground">Pedro Duarte</Text></Frame></Frame><Frame flex="col" gap={8} w="fill"><Text size={14} weight="medium" color="var:foreground">Username</Text><Frame w="fill" h={40} bg="var:background" stroke="var:input" strokeWidth={1} rounded={6} flex="row" items="center" px={12}><Text size={14} color="var:foreground">@peduarte</Text></Frame></Frame></Frame><Frame grow={1} /><Frame bg="var:primary" px={16} py={8} rounded={6} flex="row" justify="center" items="center"><Text size={14} weight="medium" color="var:primary-foreground">Save changes</Text></Frame></Frame>` },
  ],

  // ── Hover Card ──────────────────────────────────────────────────────
  'hover-card': () => [
    { name: 'Hover Card', jsx: `<Frame name="Hover Card" w={320} bg="var:card" stroke="var:border" strokeWidth={1} rounded={8} p={16} flex="row" gap={16} shadow="0px 4px 12px rgba(0,0,0,0.1)"><Frame w={40} h={40} bg="var:muted" rounded={9999} flex="row" justify="center" items="center"><Text size={16} weight="medium" color="var:muted-foreground">@</Text></Frame><Frame flex="col" gap={8} w="fill"><Frame flex="col" gap={2} w="fill"><Text size={14} weight="semibold" color="var:card-foreground" w="fill">@nextjs</Text><Text size={14} color="var:muted-foreground" w="fill">The React Framework, created and maintained by @vercel.</Text></Frame><Text size={12} color="var:muted-foreground">Joined December 2021</Text></Frame></Frame>` },
  ],
};

const VISUAL_COMPONENTS = Object.keys(components);

const INTERACTIVE_ONLY = [
  'context-menu', 'command', 'combobox',
  'menubar', 'sidebar', 'collapsible', 'carousel',
  'scroll-area', 'calendar', 'sonner', 'form', 'resizable',
  'drawer', 'popover',
];

export function listComponents() {
  return { available: VISUAL_COMPONENTS, interactive: INTERACTIVE_ONLY };
}

export function getComponent(name) {
  const fn = components[name];
  if (!fn) return null;
  return fn();
}

export function getAllComponents() {
  const all = [];
  for (const name of VISUAL_COMPONENTS) {
    all.push(...components[name]());
  }
  return all;
}

export { VISUAL_COMPONENTS, INTERACTIVE_ONLY };
