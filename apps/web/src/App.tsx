import { Home } from './pages/Home';
import { Issues } from './pages/Issues';
import { Library } from './pages/Library';
import { Onboarding } from './pages/onboarding/Onboarding';
import { Settings } from './pages/Settings';
import { SignIn } from './pages/SignIn';

export function App() {
  switch (location.pathname) {
    case '/signin':
      return <SignIn />;
    case '/app':
      return <Library />;
    case '/app/issues':
      return <Issues />;
    case '/app/welcome':
      return <Onboarding />;
    case '/app/settings':
      return <Settings />;
    default:
      return <Home />;
  }
}
