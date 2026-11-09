import { accents, neutrals } from './design/tokens';

/**
 * Phase 0 placeholder. Shows the project name and the palette so the token
 * file can be checked visually. The 3D world replaces this in Phase 1.
 */
export function App() {
  return (
    <main className="placeholder">
      <h1>{__PROJECT_NAME__}</h1>
      <p className="subtitle">Scaffold ready. The city of light arrives in Phase 1.</p>
      <section aria-label="Palette">
        <Swatches title="Accents" colors={accents} />
        <Swatches title="Neutrals" colors={neutrals} />
      </section>
    </main>
  );
}

function Swatches({ title, colors }: { title: string; colors: Record<string, string> }) {
  return (
    <div className="swatch-group">
      <h2>{title}</h2>
      <ul>
        {Object.entries(colors).map(([name, value]) => (
          <li key={name}>
            <span className="swatch" style={{ background: value }} />
            <code>{name}</code>
            <code className="value">{value}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
