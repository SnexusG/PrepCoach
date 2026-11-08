import { Route, Routes } from 'react-router-dom';
import Home from './pages/Home';
import ProblemPage from './pages/ProblemPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/problem/:slug" element={<ProblemPage />} />
      <Route path="*" element={<div className="page-msg">Page not found. <a href="/">Home</a></div>} />
    </Routes>
  );
}
