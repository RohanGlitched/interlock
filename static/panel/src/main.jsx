import { createRoot } from 'react-dom/client';
import { enableTheme } from './bridge.js';
import App from './App.jsx';
import './styles.css';
import { Component } from 'react';

// If anything fails while drawing, say so plainly instead of leaving an empty frame.
class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, font: '14px system-ui, sans-serif' }} role="alert">
        <p><b>{this.props.name} ran into a problem drawing this view.</b></p>
        <p>{String(this.state.error.message || this.state.error)}</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

enableTheme().catch(() => {}).finally(() => createRoot(document.getElementById('root')).render(<Boundary name="Interlock"><App /></Boundary>));
