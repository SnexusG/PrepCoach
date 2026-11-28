import { Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Drill from './pages/Drill';
import History from './pages/History';
import Home from './pages/Home';
import ProblemPage from './pages/ProblemPage';
import Trophies from './pages/Trophies';
import RewardOverlay from './components/RewardOverlay';

export default function App() {
  return (
    <>
    <RewardOverlay />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/drill" element={<Drill />} />
      <Route path="/history" element={<History />} />
      <Route path="/problem/:slug" element={<ProblemPage />} />
      <Route path="/trophies" element={<Trophies />} />
      <Route path="*" element={<div className="page-msg">Page not found. <a href="/">Home</a></div>} />
    </Routes>
    </>
  );
}
