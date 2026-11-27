import { useEffect, useState } from 'react';
import { detectPrintTransport, type PrintTransport } from './localPrinterPrint';

/** Android APK, local print bridge, or neither. Rechecks when the window focuses. */
export function usePrintTransport(): PrintTransport | 'pending' {
  const [transport, setTransport] = useState<PrintTransport | 'pending'>('pending');

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void detectPrintTransport().then(next => {
        if (active) setTransport(next);
      });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return transport;
}
