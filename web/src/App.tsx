import { Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import History from './pages/History';
import ProblemPage from './pages/ProblemPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/history" element={<History />} />
      <Route path="/problem/:slug" element={<ProblemPage />} />
      <Route path="*" element={<div className="page-msg">Page not found. <a href="/">Dashboard</a></div>} />
    </Routes>
  );
}
