import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://uniflow.marou.one',
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    starlight({
      title: 'Uniflow',
      description: 'Open-source Customer Data Platform — self-hosted on AWS',
      prerender: true,
      components: {
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
      },
      logo: {
        src: './src/assets/logo.svg',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/maroil/uniflow' },
      ],
      customCss: ['./src/styles/global.css'],
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Architecture',
          autogenerate: { directory: 'architecture' },
        },
        {
          label: 'Client SDKs',
          autogenerate: { directory: 'sdks' },
        },
        {
          label: 'API Reference',
          autogenerate: { directory: 'api' },
        },
        {
          label: 'Connectors',
          autogenerate: { directory: 'connectors' },
        },
        {
          label: 'CLI',
          autogenerate: { directory: 'cli' },
        },
        {
          label: 'Deployment',
          autogenerate: { directory: 'deployment' },
        },
      ],
    }),
  ],
});
