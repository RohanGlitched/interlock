import { createRoot } from 'react-dom/client';
import { enableTheme } from './bridge.js';
import App from './App.jsx';
import './styles.css';

enableTheme().catch(() => {}).finally(() => createRoot(document.getElementById('root')).render(<App />));
