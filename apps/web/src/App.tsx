import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { Settings } from './pages/Settings';
import { SignIn } from './pages/SignIn';

export function App() {
  switch (location.pathname) {
    case '/signin':
      return <SignIn />;
    case '/app':
      return <Library />;
    case '/app/settings':
      return <Settings />;
    default:
      return <Home />;
  }
}
