"""Harbor adapter for Friday's headless TypeScript CLI."""

import json
import shlex
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory


class FridayAgent(BaseInstalledAgent):
    SUPPORTS_ATIF = True
    MODEL_CONNECTION = ModelConnectionSpec()

    @staticmethod
    @override
    def name() -> str:
        return "friday"

    @override
    def get_version_command(self) -> str:
        return "friday --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("bash", "curl", "git", "nodejs", "npm")
        )
        package = self._get_env("FRIDAY_NPM_SPEC")
        install_command = (
            f"npm install --global {shlex.quote(package)}"
            if package
            else (
                'source_dir="$(mktemp -d)"; package_dir="$(mktemp -d)"; '
                "git clone --depth 1 --branch codex/typescript-rewrite "
                'https://github.com/Lancetwang/friday.git "$source_dir"; '
                '(cd "$source_dir" && npm ci && '
                'npm pack --pack-destination "$package_dir"); '
                'npm install --global "$package_dir"/friday-agent-*.tgz'
            )
        )
        installed = await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if ! node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'; then "
                "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; "
                '  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 22; '
                "fi; "
                'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; '
                f"{install_command}; "
                "command -v node; command -v friday"
            ),
        )
        paths = [line for line in (installed.stdout or "").splitlines() if line]
        if len(paths) < 2:
            raise RuntimeError("Friday installed, but its node/friday executables were not found.")
        node, friday = paths[-2:]
        await self.exec_as_root(
            environment,
            command=(
                f"ln -sf {shlex.quote(node)} /usr/local/bin/node; "
                f"ln -sf {shlex.quote(friday)} /usr/local/bin/friday"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        connection = self.model_connection
        if not self.model_name or not connection.api_key:
            raise RuntimeError("Friday requires a Harbor model and its API key.")
        provider = connection.provider or "openai"
        model = self.model_name.split("/", 1)[-1]
        friday_provider = provider if provider in {"anthropic", "openai"} else "openai-compatible"
        base_url = connection.base_url
        if not base_url:
            if friday_provider == "anthropic":
                base_url = "https://api.anthropic.com"
            elif friday_provider == "openai":
                base_url = "https://api.openai.com/v1"
            else:
                raise RuntimeError(f"Friday needs a base URL for provider {provider!r}.")

        await self.exec_as_agent(environment, command="mkdir -p /tmp/friday-home")
        await self._upload_config_text(
            environment,
            content=json.dumps(
                {"provider": friday_provider, "model": model, "base_url": base_url}
            ),
            remote_path="/tmp/friday-home/config.json",
            filename="config.json",
        )
        await self.exec_as_agent(
            environment,
            cwd="/app",
            env={
                "FRIDAY_HOME": "/tmp/friday-home",
                "LLM_API_KEY": connection.api_key,
            },
            command=(
                "friday run --cwd /app --trajectory /logs/agent/trajectory.json -- "
                f"{shlex.quote(instruction)}"
            ),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "trajectory.json"
        if not path.is_file():
            return
        trajectory = Trajectory.model_validate_json(path.read_text())
        if trajectory.final_metrics:
            metrics = trajectory.final_metrics
            context.cost_usd = metrics.total_cost_usd
            context.n_input_tokens = metrics.total_prompt_tokens or 0
            context.n_cache_tokens = metrics.total_cached_tokens or 0
            context.n_output_tokens = metrics.total_completion_tokens or 0
