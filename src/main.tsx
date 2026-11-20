import React from 'react';
import ReactDOM from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './index.css';
import './styles/header.css';
import './styles/banners.css';
import './styles/filters.css';
import './styles/spot-grid.css';
import './styles/spot-card.css';
import './styles/leaflet.css';
import './styles/modals.css';
import './styles/create-listing.css';
import './styles/wallet.css';
import './styles/activity.css';
import './styles/toast.css';
import './styles/footer.css';
import './styles/responsive.css';
import './styles/accessibility.css';
import './styles/bid-history.css';
import './styles/inbox.css';
import './styles/host-verification.css';
import './styles/shared.css';
import { App } from './App';

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
