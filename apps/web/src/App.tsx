import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { SignIn } from './pages/SignIn';

export function App() {
  switch (location.pathname) {
    case '/signin':
      return <SignIn />;
    case '/app':
      return <Library />;
    default:
      return <Home />;
  }
}
