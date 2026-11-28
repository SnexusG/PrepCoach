import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { gameApi } from '../api';
import { useTutor } from '../tutor/TutorContext';
import { usePolling } from '../usePolling';
import { levelColor, levelIndex } from './LevelScale';

/** Streak, quests and level at a glance; links to the Trophies page. */
function GameChip() {
  const { turns } = useTutor();
  const { data } = usePolling(gameApi.summary, 15000, [turns]);
  if (!data) return null;
  const idx = levelIndex(data.rating, data.levels);
  return (
    <NavLink
      to="/trophies"
      className="game-chip"
      title={`${data.streak}-day streak${data.activeToday ? '' : ' — practise today to keep it'} · quests ${data.questsDone}/${data.questsTotal} · ${data.badges}/${data.badgesTotal} badges · ${Math.round(data.rating)} ${data.label}`}
    >
      <span className={`gc-streak ${data.activeToday ? 'lit' : ''}`}>🔥 {data.streak}</span>
      {data.freezes > 0 && <span className="gc-freeze">❄{data.freezes > 1 ? data.freezes : ''}</span>}
      <span className="gc-sep" />
      <span className="gc-quests">✓ {data.questsDone}/{data.questsTotal}</span>
      <span className="gc-sep" />
      <span className="gc-level">
        <span className="lvl-dot" style={{ background: levelColor(idx, data.levels.length) }} />
        {data.label}
      </span>
    </NavLink>
  );
}

/** Top bar shared by every page: brand, page links, page-specific content, then the game chip (`game={false}` hides it). */
export default function NavBar({ children, game = true }: { children?: ReactNode; game?: boolean }) {
  return (
    <header className="topbar">
      <NavLink to="/" className="brand">PrepCoach</NavLink>
      <nav className="nav">
        <NavLink to="/" end>Home</NavLink>
        <NavLink to="/drill">Drill</NavLink>
        <NavLink to="/dashboard">Dashboard</NavLink>
        <NavLink to="/history">History</NavLink>
        <NavLink to="/trophies">Trophies</NavLink>
      </nav>
      {children}
      {game && (
        <>
          <span className="spacer" />
          <GameChip />
        </>
      )}
    </header>
  );
}
