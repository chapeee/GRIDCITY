import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

const organizationName = 'chapeee';
const projectName = 'GRIDCITY';
const repositoryUrl = `https://github.com/${organizationName}/${projectName}`;
// GitHub Pages by default. DOCS_URL and DOCS_BASE_URL override it for a custom
// domain or previews; canonical links, the sitemap and social cards follow.
const SITE_URL = `https://${organizationName}.github.io`;
const url = process.env.DOCS_URL?.replace(/\/+$/, '') || SITE_URL;
const baseUrl = process.env.DOCS_BASE_URL || `/${projectName}/`;
const description =
  'GRIDCITY is a local-first server monitor, database admin and security console in a 3D city: SSH servers, PostgreSQL, MySQL, MongoDB, Redis, S3 and AWS, with attack detection, alerts that reach you with the app closed, a Doctor that proves fixes, time travel, and an MCP server for Claude Code and other AI agents.';

const config: Config = {
  title: 'GRIDCITY',
  tagline: 'Your servers as a living city of light.',
  favicon: 'img/favicon.svg',
  url,
  baseUrl,
  organizationName,
  projectName,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  trailingSlash: true,

  markdown: {
    // `.md` is plain CommonMark (write `<host>` or `{id}` safely); `.mdx` may use React.
    format: 'detect',
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  clientModules: ['./src/client/fonts.ts'],

  headTags: [
    {
      tagName: 'script',
      attributes: { type: 'application/ld+json' },
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'GRIDCITY',
        description,
        url: `${url}${baseUrl}`,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Windows, macOS, Linux',
        softwareRequirements: 'Node.js 22.12+ or Docker',
        license: 'https://opensource.org/licenses/MIT',
        downloadUrl: 'https://www.npmjs.com/package/gridcity',
        codeRepository: repositoryUrl,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      }),
    },
  ],

  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: '/docs',
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        searchBarShortcutHint: true,
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          showLastUpdateTime: true,
          editUrl: `${repositoryUrl}/edit/main/website/`,
        },
        blog: false,
        sitemap: {
          lastmod: 'date',
          changefreq: 'weekly',
          priority: 0.5,
          ignorePatterns: ['/search/**', '/tags/**'],
          filename: 'sitemap.xml',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/overview.png',
    metadata: [
      { name: 'description', content: description },
      {
        name: 'keywords',
        content:
          'GRIDCITY, server monitoring, MCP server, Model Context Protocol, Claude Code, AI agents, database admin, PostgreSQL, MySQL, MongoDB, Redis, S3, AWS, intrusion detection, CrowdSec, Fail2ban, web push alerts, uptime monitoring, homelab, devops, observability, self-hosted, local-first, 3D',
      },
      { name: 'twitter:card', content: 'summary_large_image' },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'GRIDCITY' },
      { name: 'theme-color', content: '#050708' },
    ],
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
      respectPrefersColorScheme: false,
    },
    announcementBar: {
      id: 'v0-4-demo',
      content: `GRIDCITY 0.4 is out: <code>npx gridcity demo</code>, or <a href="${baseUrl}demo/">try the live demo in your browser</a>. <a href="${baseUrl}docs/guides/security/">See who is attacking what</a>, <a href="${baseUrl}docs/guides/manage/">manage databases and buckets</a>, and get <a href="${baseUrl}docs/guides/alerts/">alerts with the app closed</a>.`,
      isCloseable: true,
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: false,
      },
    },
    navbar: {
      title: 'GRIDCITY',
      hideOnScroll: false,
      logo: {
        alt: 'GRIDCITY',
        src: 'img/favicon.svg',
      },
      items: [
        { type: 'doc', docId: 'intro', position: 'left', label: 'Docs' },
        { type: 'doc', docId: 'guides/doctor', position: 'left', label: 'Guides' },
        { type: 'doc', docId: 'reference/cli', position: 'left', label: 'Reference' },
        { type: 'doc', docId: 'architecture/overview', position: 'left', label: 'Architecture' },
        { type: 'doc', docId: 'contributing/index', position: 'left', label: 'Contributing' },
        { to: 'pathname:///demo/', label: 'Live demo', position: 'right' },
        { type: 'doc', docId: 'getting-started/desktop-app', label: 'Download', position: 'right' },
        { href: 'https://www.npmjs.com/package/gridcity', label: 'npm', position: 'right' },
        { type: 'search', position: 'right' },
        {
          href: repositoryUrl,
          position: 'right',
          className: 'header-github-link',
          'aria-label': 'GitHub repository',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Start',
          items: [
            { label: 'Overview', to: '/docs/' },
            { label: 'Installation', to: '/docs/getting-started/installation/' },
            { label: 'Quick start', to: '/docs/getting-started/quick-start/' },
            { label: 'Command reference', to: '/docs/reference/cli/' },
          ],
        },
        {
          title: 'Learn',
          items: [
            { label: 'The Doctor', to: '/docs/guides/doctor/' },
            { label: 'Reading the city', to: '/docs/concepts/reading-the-city/' },
            { label: 'Security', to: '/docs/concepts/security/' },
            { label: 'Troubleshooting', to: '/docs/troubleshooting/' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: repositoryUrl },
            { label: 'npm', href: 'https://www.npmjs.com/package/gridcity' },
            { label: 'Issues', href: `${repositoryUrl}/issues` },
            { label: 'Contributing', to: '/docs/contributing/' },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} GRIDCITY contributors · MIT License`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.nightOwl,
      additionalLanguages: ['bash', 'powershell', 'json', 'yaml', 'sql'],
    },
    mermaid: {
      theme: { light: 'neutral', dark: 'dark' },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
