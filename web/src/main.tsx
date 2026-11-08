import { loader } from '@monaco-editor/react';
// Editor core (find, folding, etc.) + only the Java grammar — not every language Monaco ships.
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { TutorProvider } from './tutor/TutorContext';
import './styles.css';

// Bundle Monaco locally (the default loader pulls it from a CDN; PrepCoach runs fully offline).
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <TutorProvider>
        <App />
      </TutorProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
