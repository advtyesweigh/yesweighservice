import type { TranscriptTurn } from '../../lib/phoneLog';

/** Same speaker lines as Meezan: agent is green, customer is blue. */
export function CallTranscriptTurns({ turns }: { turns: readonly TranscriptTurn[] }) {
  const lines = turns.filter(turn => turn.text.trim());
  if (!lines.length) return null;
  return (
    <div className="call-transcript__turns">
      {lines.map((turn, index) => (
        <div
          key={`${turn.speaker}-${index}`}
          className={`call-transcript__turn call-transcript__turn--${turn.speaker}`}
        >
          <p className="call-transcript__line">{turn.text}</p>
        </div>
      ))}
    </div>
  );
}
