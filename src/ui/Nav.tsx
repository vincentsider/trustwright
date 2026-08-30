// src/ui/Nav.tsx
//
// The header. On the landing it is Apple-like: near-white, translucent with a
// blur, a single hairline, small quiet links and no boxed button. On the
// console pages it keeps the darker instrument palette.

import { NavLink, useLocation } from 'react-router-dom';
import { Logo } from './Logo.tsx';

const GITHUB = 'https://github.com/vincentsider/trustwright';

export function Nav() {
  const light = useLocation().pathname === '/';
  return (
    <nav className={`nav${light ? ' nav-light' : ''}`}>
      <div className="nav-inner">
        <NavLink to="/" className="brand">
          <Logo />
          Trustwright
        </NavLink>
        <div className="nav-links">
          <NavLink to="/range" className="nav-link">
            Test an agent
          </NavLink>
          <NavLink to="/scan" className="nav-link">
            Scan a site
          </NavLink>
          <NavLink to="/badge" className="nav-link">
            Get a badge
          </NavLink>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="nav-link">
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}
