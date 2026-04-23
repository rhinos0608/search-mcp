from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

TEXT_EMBEDDING_PREFIX = "text-embedding-"


def normalize_model_id(model_id: str) -> str:
    normalized = model_id.strip().lower()
    if normalized.startswith(TEXT_EMBEDDING_PREFIX):
        normalized = normalized[len(TEXT_EMBEDDING_PREFIX) :]
    return normalized


def list_lmstudio_embedding_model_ids(
    lmstudio_models: Sequence[Mapping[str, Any]],
) -> list[str]:
    model_ids: list[str] = []

    for model in lmstudio_models:
        if not isinstance(model, Mapping):
            continue
        if model.get("type") != "embedding":
            continue

        for field in ("key", "display_name"):
            value = model.get(field)
            if isinstance(value, str) and value.strip():
                model_ids.append(value)

        loaded_instances = model.get("loaded_instances")
        if not isinstance(loaded_instances, list):
            continue

        for instance in loaded_instances:
            if not isinstance(instance, Mapping):
                continue
            instance_id = instance.get("id")
            if isinstance(instance_id, str) and instance_id.strip():
                model_ids.append(instance_id)

    return model_ids


def is_embedding_model_available(
    expected_model: str,
    openai_model_ids: Sequence[str],
    lmstudio_models: Sequence[Mapping[str, Any]],
) -> bool:
    expected = normalize_model_id(expected_model)

    for model_id in openai_model_ids:
        if normalize_model_id(model_id) == expected:
            return True

    for candidate in list_lmstudio_embedding_model_ids(lmstudio_models):
        if normalize_model_id(candidate) == expected:
            return True

    return False
