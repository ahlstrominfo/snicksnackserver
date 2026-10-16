// Kroken efter mottagning. Anropas en gång per mottaget snack (även vid omsändning), efter att filerna
// sparats i R2 och indexet uppdaterats. Svaret till appen väntar inte på den (ctx.waitUntil), och ett fel
// här påverkar inte mottagningen.
//
// Här kan e-post till ägaren, en webhook, ett MCP-index eller annat läggas till senare.

export interface MottagetSnack {
  /** Samma id som i svaret till appen: <mål>/<avsändare>/<snack-id>. */
  id: string;
  /** Snackets sida i admin. */
  url: string;
  snackId: string;
  mål: { id: string; name: string };
  avsändare: { id: string; name: string };
  title: string | null;
  recordedAt: string | null;
  duration: number | null;
  language: string | null;
  tags: string[];
  /** Filerna i R2 för snacket, t.ex. ["audio.m4a", "text.md", "transcript.json"]. */
  filer: string[];
  /** Nyckelprefix i R2: <mål>/<avsändare>/<snack-id>/ */
  prefix: string;
  /** true första gången, false vid omsändning. */
  ny: boolean;
  mottaget: string;
}

export async function efterMottagning(snack: MottagetSnack, _env: Env): Promise<void> {
  console.log(
    JSON.stringify({
      händelse: "mottaget",
      id: snack.id,
      ny: snack.ny,
      titel: snack.title,
      avsändare: snack.avsändare.name,
      mål: snack.mål.name,
      filer: snack.filer,
    }),
  );
}
