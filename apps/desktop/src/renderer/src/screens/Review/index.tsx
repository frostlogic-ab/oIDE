/**
 * PLACEHOLDER: Review changes (docs/wiki/raw/design/Review.dc.html), implemented in wave 2.
 * Shows how a screen fills the header title slot with a breadcrumb.
 */
import { ScreenPlaceholder } from '../../components/ScreenPlaceholder';
import { HeaderSlot } from '../../components/frame/HeaderSlot';
import { useAgent } from '../../stores/agents';
import { projectName, useProjects } from '../../stores/projects';
import { navigate, useRouter } from '../../stores/router';

export default function ReviewScreen() {
  const route = useRouter((s) => s.route);
  const agent = useAgent(route.screen === 'review' ? route.params.agentId : undefined);
  const projects = useProjects((s) => s.list);
  return (
    <>
      <HeaderSlot name="title">
        <nav aria-label="Breadcrumb" className="text-ink-3 text-[12.5px] flex gap-1.5 items-center whitespace-nowrap">
          <a
            href="#source-control"
            className="text-link no-underline"
            onClick={(e) => {
              e.preventDefault();
              navigate('source-control');
            }}
          >
            Source control
          </a>
          {agent && (
            <>
              <span aria-hidden="true">/</span>
              <span>{projectName(projects, agent.projectId)}</span>
            </>
          )}
          <span aria-hidden="true">/</span>
          <span className="text-ink">Review{agent ? `: ${agent.title}` : ''}</span>
        </nav>
      </HeaderSlot>
      <ScreenPlaceholder title="Review changes" design="Review.dc.html" icon="source-control" description="Changed files, unified or split diff, Viewed checkboxes, inline comments, summary and checks." />
    </>
  );
}
