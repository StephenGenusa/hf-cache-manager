import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/toast';
import { ApiProvider } from './lib/api';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ApiProvider api={window.api}>
        <TooltipProvider delayDuration={300}>
          <Toaster>
            <App />
          </Toaster>
        </TooltipProvider>
      </ApiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
