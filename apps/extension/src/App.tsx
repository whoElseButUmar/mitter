import { createWorkspaceController } from './ui/workspace-controller';
import { WorkspaceView } from './views/WorkspaceView';
import { WorkspaceDialogs } from './views/WorkspaceDialogs';
import './style.css';

export default function App() {
  const controller = createWorkspaceController();

  return (
    <WorkspaceView controller={controller}>
      <WorkspaceDialogs controller={controller} />
    </WorkspaceView>
  );
}
