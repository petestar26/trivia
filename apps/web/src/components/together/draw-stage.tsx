import { useId } from 'react';
import { togetherGame, type TogetherGame, type TogetherGameEvent } from '@socialplay/shared';
import { useTogetherText } from '@/lib/i18n/together-text';

type Ball = Extract<TogetherGameEvent, { kind: 'ball' }>;

function OrbitalMachine({
  id,
  last,
  drawn,
  elapsed,
  reduced,
}: {
  id: string;
  last?: Ball;
  drawn: Set<number>;
  elapsed: number;
  reduced: boolean;
}) {
  const { num } = useTogetherText();
  const point = (a: number, r: number) => [200 + Math.sin(a) * r, 160 - Math.cos(a) * r];
  return (
    <g>
      <ellipse cx="200" cy="326" rx="166" ry="17" fill="#0008" />
      <path
        d="M64 202L79 304Q200 347 321 304L336 202Z"
        fill={'url(#' + id + 'metal)'}
        stroke="#6d6d87"
        strokeWidth="4"
      />
      <path
        d="M85 280Q200 314 315 280M88 293Q200 327 312 293"
        fill="none"
        stroke="#292738"
        strokeWidth="4"
      />
      <circle
        cx="200"
        cy="160"
        r="151"
        fill="#171827"
        stroke={'url(#' + id + 'metal)'}
        strokeWidth="13"
      />
      <circle cx="200" cy="160" r="139" fill="#28263c" stroke="#b7a7db" strokeWidth="2" />
      {Array.from({ length: 72 }, (_, i) => {
        const a = point((i * Math.PI) / 36, 134),
          b = point(((i + 1) * Math.PI) / 36, 134),
          label = point(((i + 0.5) * Math.PI) / 36, 120);
        return (
          <g key={i}>
            <path
              d={`M200 160L${a.join(' ')}A134 134 0 0 1 ${b.join(' ')}Z`}
              fill={
                last?.value === i + 1
                  ? '#f4d8a0'
                  : drawn.has(i + 1)
                    ? '#8c7cb7'
                    : i % 2
                      ? '#3d304a'
                      : '#222b44'
              }
              stroke="#d7c6e54a"
              strokeWidth=".7"
            />
            {i % 3 === 2 && (
              <text
                x={label[0]}
                y={label[1]}
                fill="#eee3d5"
                fontSize="9"
                textAnchor="middle"
                dominantBaseline="middle"
                transform={`rotate(${(i + 0.5) * 5} ${label[0]} ${label[1]})`}
              >
                {num(i + 1)}
              </text>
            )}
          </g>
        );
      })}
      <circle
        cx="200"
        cy="160"
        r="103"
        fill={'url(#' + id + 'metal)'}
        stroke="#c8b7df"
        strokeWidth="3"
      />
      <circle cx="200" cy="160" r="91" fill="#101d30" stroke="#e4d3eb44" strokeWidth="2" />
      <g transform={`rotate(${reduced ? 0 : elapsed / 70} 200 160)`} stroke="#9c8da5" fill="none">
        {[0, 60, 120].map((a) => (
          <ellipse key={a} cx="200" cy="160" rx="78" ry="25" transform={`rotate(${a} 200 160)`} />
        ))}
      </g>
      <path
        d="M62 123A142 142 0 0 1 237 22"
        fill="none"
        stroke="#eadfff"
        strokeWidth="5"
        opacity=".3"
        strokeLinecap="round"
      />
      <rect x="177" y="306" width="46" height="5" rx="2" fill="#c9b3f5" />
    </g>
  );
}

function LotteryMachine({
  id,
  elapsed,
  reduced,
  balls,
}: {
  id: string;
  elapsed: number;
  reduced: boolean;
  balls: Ball[];
}) {
  const { num } = useTogetherText();
  return (
    <g>
      <ellipse cx="200" cy="335" rx="168" ry="15" fill="#0008" />
      <rect
        x="52"
        y="38"
        width="32"
        height="275"
        rx="7"
        fill={'url(#' + id + 'metal)'}
        stroke="#eac9ad88"
      />
      <rect
        x="274"
        y="38"
        width="32"
        height="275"
        rx="7"
        fill={'url(#' + id + 'metal)'}
        stroke="#eac9ad88"
      />
      <rect
        x="78"
        y="40"
        width="202"
        height="245"
        rx="34"
        fill={'url(#' + id + 'glass)'}
        stroke="#e9ccdc"
        strokeWidth="3"
      />
      <path
        d="M100 248Q179 185 258 248L225 282H133Z"
        fill="#7b506f"
        stroke="#e8c8d7"
        strokeWidth="2"
      />
      {Array.from({ length: 20 }, (_, i) => {
        const phase = (reduced ? 0 : elapsed / 1000) + i * 2.4;
        return (
          <circle
            key={i}
            cx={178 + Math.sin(phase) * 75}
            cy={148 + Math.cos(phase * (1 + (i % 3) * 0.15)) * 76}
            r={9 + (i % 4)}
            fill={['#ddb4ca', '#d1b5ef', '#f3d2a0', '#a5cbd1'][i % 4]}
            stroke="#fff4"
            opacity=".8"
          />
        );
      })}
      <rect
        x="68"
        y="25"
        width="223"
        height="32"
        rx="8"
        fill={'url(#' + id + 'metal)'}
        stroke="#c4a9b3"
      />
      {Array.from({ length: 15 }, (_, i) => (
        <path key={i} d={`M${91 + i * 12} 34v13`} stroke="#162631" strokeWidth="4" />
      ))}
      <path
        d="M91 90Q92 65 118 65M91 97V183"
        stroke="#fff"
        strokeWidth="6"
        strokeLinecap="round"
        opacity=".22"
        fill="none"
      />
      <path
        d="M246 242H314V267"
        stroke="#b8b5c6"
        strokeWidth="24"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M246 238H317V263"
        stroke="#eae5ea"
        strokeWidth="4"
        strokeLinejoin="round"
        fill="none"
        opacity=".6"
      />
      <rect
        x="52"
        y="293"
        width="294"
        height="36"
        rx="9"
        fill={'url(#' + id + 'metal)'}
        stroke="#b28b9b"
      />
      {Array.from({ length: 6 }, (_, i) => (
        <g key={i}>
          <circle cx={85 + i * 41} cy="311" r="14" fill="#201e31" stroke="#b78eae" />
          <text
            x={85 + i * 41}
            y="312"
            fill="#f6dde9"
            fontSize="13"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {balls.slice(-6)[i] ? num(balls.slice(-6)[i].value) : '·'}
          </text>
        </g>
      ))}
    </g>
  );
}
export function DrawStage({
  game,
  balls,
  picks,
  elapsed,
  reduced,
}: {
  game: TogetherGame;
  balls: Ball[];
  picks: number[];
  elapsed: number;
  reduced: boolean;
}) {
  const { t, num } = useTogetherText(),
    id = useId().replace(/:/g, '');
  const rule = togetherGame(game),
    drawn = new Set(balls.map((b) => b.value));
  const last = balls.at(-1),
    age = last ? Math.max(0, elapsed - last.atMs) : 0;
  const orbital = game === 'roulette_keno',
    lottery = game === 'lucky_six';
  const count = lottery ? 35 : orbital ? 18 : 20;
  return (
    <div
      className={'tg-draw-stage ' + (orbital ? 'is-orbital' : lottery ? 'is-lottery' : 'is-turbo')}
    >
      <div className="tg-draw-machine">
        <div className="tg-stage-caption">
          <span>{t('Drawn balls')}</span>
          <strong>
            {num(balls.length)} / {num(count)}
          </strong>
        </div>
        <svg viewBox="0 0 400 360" aria-hidden="true">
          <defs>
            <radialGradient id={id + 'glass'} cx=".3" cy=".25">
              <stop stopColor="#d5f5ff" stopOpacity=".25" />
              <stop offset=".7" stopColor="#102a45" stopOpacity=".5" />
              <stop offset="1" stopColor="#83bacc" stopOpacity=".6" />
            </radialGradient>
            <linearGradient id={id + 'metal'} x2="0" y2="1">
              <stop stopColor="#c3ced4" />
              <stop offset=".2" stopColor="#39444d" />
              <stop offset=".5" stopColor="#71858e" />
              <stop offset="1" stopColor="#18242f" />
            </linearGradient>
            <radialGradient id={id + 'ball'} cx=".3" cy=".2">
              <stop stopColor="#fff" />
              <stop offset=".5" stopColor={lottery ? '#e5abc9' : '#8fdce5'} />
              <stop offset="1" stopColor="#1d566e" />
            </radialGradient>
            <clipPath id={id + 'globe'}>
              <circle cx="200" cy="160" r="121" />
            </clipPath>
          </defs>
          {orbital ? (
            <OrbitalMachine id={id} last={last} drawn={drawn} elapsed={elapsed} reduced={reduced} />
          ) : lottery ? (
            <LotteryMachine id={id} elapsed={elapsed} reduced={reduced} balls={balls} />
          ) : (
            <g>
              <ellipse cx="200" cy="335" rx="158" ry="15" fill="#0008" />
              <path d="M92 315L123 265H277L308 315Z" fill={'url(#' + id + 'metal)'} />
              <rect x="79" y="312" width="242" height="16" rx="7" fill="#192831" stroke="#718b98" />
              <path d="M184 277V305H216V277" fill="#122a37" stroke="#7bc3d5" strokeWidth="3" />
              <circle
                cx="200"
                cy="160"
                r="132"
                fill="#091622"
                stroke={'url(#' + id + 'metal)'}
                strokeWidth="12"
              />
              {orbital && (
                <g transform={`rotate(${reduced ? 0 : elapsed / 30} 200 160)`}>
                  {Array.from({ length: 72 }, (_, i) => (
                    <path
                      key={i}
                      d="M200 17V27"
                      stroke={i % 6 === 0 ? '#d1c7fc' : '#7481b8'}
                      strokeWidth={i % 6 === 0 ? 3 : 1}
                      transform={`rotate(${i * 5} 200 160)`}
                    />
                  ))}
                </g>
              )}
              <circle
                cx="200"
                cy="160"
                r="122"
                fill={'url(#' + id + 'glass)'}
                stroke="#aed9ec88"
                strokeWidth="2"
              />
              <g clipPath={'url(#' + id + 'globe)'}>
                {Array.from({ length: 22 }, (_, i) => {
                  const phase = (reduced ? 0 : elapsed / 1400) + i * 2.399;
                  const radius = 40 + (i % 5) * 18;
                  return (
                    <circle
                      key={i}
                      cx={200 + Math.cos(phase) * radius}
                      cy={166 + Math.sin(phase * 1.17) * radius}
                      r={11 + (i % 3) * 2}
                      fill={'url(#' + id + 'ball)'}
                      opacity={0.4 + (i % 3) * 0.2}
                    />
                  );
                })}
                <path
                  d="M90 135Q200 222 310 135M105 210Q200 134 295 210"
                  fill="none"
                  stroke="#a0d0e533"
                  strokeWidth="4"
                />
              </g>
              <path
                d="M112 111Q135 54 202 51"
                fill="none"
                stroke="#e2f5ff"
                strokeWidth="9"
                strokeLinecap="round"
                opacity=".38"
              />
              <path
                d="M292 179Q288 225 257 248"
                fill="none"
                stroke="#c3e5f4"
                strokeWidth="4"
                opacity=".25"
              />
            </g>
          )}
          <g
            transform={`translate(${lottery ? 314 : 200} ${(lottery ? 257 : 160) - (reduced ? 0 : Math.max(0, 1 - age / 500)) * 50})`}
            opacity={last ? 1 : 0.65}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            <circle r="49" fill={'url(#' + id + 'ball)'} stroke="#e7f8fa" strokeWidth="2" />
            <circle r="33" fill="#eff6f1" />
            <text
              y="2"
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#173c55"
              fontSize="34"
              fontWeight="800"
            >
              {last ? num(last.value) : '—'}
            </text>
          </g>
          <circle cx="134" cy="320" r="3" fill="#90f8b8" />
          <path d="M155 320H265" stroke="#56acbd" strokeWidth="2" />
        </svg>
        <div className="tg-draw-current" aria-live="polite">
          {last ? t('Ball {number}', { number: num(last.value) }) : t('Preparing the round')}
        </div>
        <ol className="tg-ball-rail" aria-label={t('Drawn balls')}>
          {balls.map((ball, i) => (
            <li key={i} data-hit={picks.includes(ball.value)}>
              {num(ball.value)}
            </li>
          ))}
        </ol>
      </div>
      <div className="tg-number-board">
        <div className="tg-board-heading">
          <span>{picks.length ? t('Your choice') : t('Shared game screen')}</span>
          <b>
            {num(rule.min)}—{num(rule.max)}
          </b>
        </div>
        <div
          className="tg-number-grid"
          style={{ '--draw-columns': lottery ? 8 : orbital ? 9 : 10 } as React.CSSProperties}
        >
          {Array.from({ length: rule.max }, (_, i) => i + 1).map((n) => (
            <span
              key={n}
              data-drawn={drawn.has(n)}
              data-picked={picks.includes(n)}
              data-current={last?.value === n}
              aria-label={num(n) + (drawn.has(n) ? ' · ' + t('Drawn balls') : '')}
            >
              {num(n)}
              {picks.includes(n) && <i aria-hidden="true" />}
            </span>
          ))}
        </div>
        {picks.length > 0 && (
          <div className="tg-ticket-strip">
            <span>{t('Your choice')}</span>
            {picks.map((n) => (
              <b key={n} data-hit={drawn.has(n)}>
                {num(n)}
              </b>
            ))}
            <strong>
              {t('{count} matches', { count: picks.filter((n) => drawn.has(n)).length })}
            </strong>
          </div>
        )}
      </div>
    </div>
  );
}
