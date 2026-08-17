// Phase 5 runtime recovery: a presentation-local error boundary that resets
// when its avatar identity changes. It is not a global error system.
import { Component, type ReactNode } from 'react';

interface AvatarRuntimeErrorBoundaryProps {
  avatarIdentity: string;
  onError?: (message: string) => void;
  children: ReactNode;
}

interface AvatarRuntimeErrorBoundaryState {
  hasError: boolean;
}

export class AvatarRuntimeErrorBoundary extends Component<AvatarRuntimeErrorBoundaryProps, AvatarRuntimeErrorBoundaryState> {
  state: AvatarRuntimeErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AvatarRuntimeErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error.message);
  }

  componentDidUpdate(previousProps: AvatarRuntimeErrorBoundaryProps): void {
    if (previousProps.avatarIdentity !== this.props.avatarIdentity && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    return this.state.hasError ? null : this.props.children;
  }
}
