# dsh-media-studio

Un plugin de DeepSeek Harness (DSH) generado con [`dsh-plugin-dev new`](https://github.com/PerryLink/dsh-plugin-guide).

## Compatibility

| Superficie | Estado |
|---|---|
| Harness | DeepSeek Harness `0.1.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| Plataformas | Todas (ESM puro; sin código nativo, sin red) |

## What it does

Registra la herramienta `media-studio_echo`. Al llamarla responde `<greeting>: <text>`, donde `<greeting>` proviene de la configuración del plugin y `<text>` es el argumento.

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-media-studio-0.1.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-media-studio'
```

## Configuration

| Clave | Tipo | Valor por defecto | Descripción |
|---|---|---|---|
| `greeting` | string | `Hello` | Prefijo de la respuesta echo |

La configuración se valida con el esquema Schemastery `Config` de `src/config.ts`; ningún ajuste está codificado de forma fija.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

## License

[Apache License 2.0](LICENSE) © 2026 dsh-media-studio contributors.
