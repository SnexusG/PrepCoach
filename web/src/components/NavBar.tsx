import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

/** Top bar shared by every page: brand, page links, then page-specific content. */
export default function NavBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <NavLink to="/" className="brand">PrepCoach</NavLink>
      <nav className="nav">
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/history">History</NavLink>
      </nav>
      {children}
    </header>
  );
}
