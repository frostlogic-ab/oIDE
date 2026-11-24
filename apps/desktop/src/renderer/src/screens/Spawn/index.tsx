/**
 * PLACEHOLDER: Spawn agent dialog (docs/wiki/raw/design/Spawn.dc.html), implemented in wave 2.
 * Rendered as an overlay over the Wall (`overlay: true` in screens/registry.tsx).
 */
import { Button, Dialog, EmptyState } from '@oide/ui';
import { useRouter } from '../../stores/router';

export default function SpawnScreen() {
  const close = () => {
    const { back, goBack, navigate } = useRouter.getState();
    if (back.length) goBack();
    else navigate('wall');
  };
  return (
    <Dialog
      open
      onClose={close}
      title="Spawn an agent"
      position="top"
      width={720}
      footer={
        <>
          <Button size={36} onClick={close}>
            Cancel
          </Button>
          <Button size={36} variant="primary" disabled>
            Spawn agent
          </Button>
        </>
      }
    >
      <EmptyState
        icon="plus"
        title="Spawn form is not built yet"
        description="Goal with context chips, project, Work in, permission mode, focus presets, techniques, parallel attempts and extension tools. Design: docs/wiki/raw/design/Spawn.dc.html"
      />
    </Dialog>
  );
}
