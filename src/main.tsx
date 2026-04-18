import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error("Failed to find the root element");
} else {
  try {
    createRoot(rootElement).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (error) {
    console.error("Fatal error during render:", error);
    rootElement.innerHTML = `<div style="padding: 20px; color: white; background: #0f172a; height: 100vh;">
      <h1>Application Error</h1>
      <p>Something went wrong while starting the application. Please check the console for details.</p>
      <pre>${error instanceof Error ? error.message : String(error)}</pre>
    </div>`;
  }
}

// Catch unhandled promise rejections
window.onunhandledrejection = (event) => {
  console.error('Unhandled rejection:', event.reason);
};
