import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// Written out rather than generated, so the reading order is a decision:
// start, then the guides you use every day, then how it works inside.
const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting started',
      collapsed: false,
      items: [
        'getting-started/installation',
        'getting-started/desktop-app',
        'getting-started/quick-start',
        'getting-started/connect-a-server',
        'getting-started/connect-resources',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      collapsed: false,
      items: [
        'guides/manage',
        'guides/doctor',
        'guides/time-travel',
        'guides/topology',
        'guides/districts',
        'guides/services',
        'guides/runbooks',
        'guides/terminal',
        'guides/ai-agents',
        'guides/alerts',
        'guides/security',
        'guides/upcoming',
        'guides/operations',
        'guides/history-and-settings',
        'guides/docker',
      ],
    },
    {
      type: 'category',
      label: 'Concepts',
      items: ['concepts/reading-the-city', 'concepts/truth-first', 'concepts/security'],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/cli',
        'reference/keyboard',
        'reference/configuration',
        'reference/resource-kinds',
        'reference/environment',
        'reference/mcp-tools',
        'reference/doctor-rules',
        'reference/http-api',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: ['architecture/overview', 'architecture/decisions'],
    },
    {
      type: 'category',
      label: 'Contributing',
      link: { type: 'doc', id: 'contributing/index' },
      items: ['contributing/development', 'contributing/testing', 'contributing/releasing'],
    },
    'troubleshooting',
    'faq',
  ],
};

export default sidebars;
