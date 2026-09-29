# Icon fonts

`fluent-regular-subset.woff2` and `fluent-filled-subset.woff2` are subsets of the Fluent icon fonts
shipped in [azure-devops-ui](https://www.npmjs.com/package/azure-devops-ui) 2.280.0
(`Components/Icon/fonts`, MIT license), which are built from Microsoft's Fluent UI System Icons (MIT).
They contain only the glyphs listed in `src/components/iconMap.ts` and were produced with
`pyftsubset --flavor=woff2`. Codepoints match azure-devops-ui's `FluentIcons.css`.
