"""Video checks on tiny synthetic fixtures: every result carries timestamped evidence with a screenshot."""
import os
import shutil

import pytest

from app.deals.media import VideoChecker, probe, loudness, clipping_spans
from tests.deals_fixtures import CHECKLIST, SCRIPT, TRANSCRIPT_OK, TRANSCRIPT_MISSING, logo_png, make_video

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture(scope="module")
def vids(tmp_path_factory):
    d = tmp_path_factory.mktemp("vids")
    logo = logo_png(d / "logo.pgm")
    good = make_video(d / "good.mp4", volume_db=7.0, logo=logo, logo_window=(0.0, 3.0))
    bad = make_video(d / "bad.mp4", w=1280, h=720, dur=9.5, fps=25, volume_db=-20.0, logo=logo, logo_window=(5.0, 7.0), clip=True)
    return {"dir": d, "logo": str(logo), "good": str(good), "bad": str(bad)}


def by_id(results):
    return {r.checklist_id: r for r in results}


def test_probe_and_loudness(vids):
    i = probe(vids["good"])
    assert (i.width, i.height, round(i.fps)) == (1080, 1920, 30)
    L = loudness(vids["good"])
    assert -16 <= L["integrated_lufs"] <= -12, L
    assert clipping_spans(vids["good"]) == []
    assert clipping_spans(vids["bad"]), "boosted fixture must clip"


def test_good_video_passes_every_machine_check(vids):
    ck = VideoChecker(vids["good"], str(vids["dir"] / "ev_good"), transcript=TRANSCRIPT_OK, script=SCRIPT, assets={"logo": vids["logo"]})
    res = by_id(ck.run(CHECKLIST))
    assert "t_vibe" not in res, "taste lines are never machine-judged"
    failed = {k: (r.measured, r.evidence[0].note if r.evidence else "") for k, r in res.items() if not r.passed}
    assert failed == {}
    for r in res.values():
        assert r.evidence, r.checklist_id
        assert all(e.t_end >= e.t_start for e in r.evidence)
    shots = [e.screenshot for r in res.values() for e in r.evidence if e.screenshot]
    assert shots and all(os.path.getsize(s) > 0 for s in shots)
    logo = res["c_logo"].evidence[0]
    assert logo.t_start <= 0.5 and 2.0 <= logo.t_end <= 3.0


def test_bad_video_fails_with_timestamped_evidence(vids):
    ck = VideoChecker(vids["bad"], str(vids["dir"] / "ev_bad"), transcript=TRANSCRIPT_MISSING, script=SCRIPT, assets={"logo": vids["logo"]})
    res = by_id(ck.run(CHECKLIST))
    failed = {k for k, r in res.items() if not r.passed}
    assert failed == {"c_len", "c_res", "c_ar", "c_fps", "c_loud", "c_clip", "c_logo", "c_caps"}
    assert res["c_ar"].measured == "16:9"
    assert res["c_res"].measured == 720
    clip = res["c_clip"].evidence[0]
    assert clip.screenshot and clip.t_end > clip.t_start
    caps = res["c_caps"]
    assert caps.measured < 0.95
    assert any("Book your seat now" in e.note and e.t_start == 4.1 for e in caps.evidence)
    assert "not found" in res["c_logo"].evidence[0].note


def test_logo_outside_window_is_not_counted(vids):
    item = {"id": "late", "text": "logo after 4s", "kind": "check", "measure": {"metric": "logo_present", "op": "present", "value": "logo", "window": [4, 8]}}
    r = VideoChecker(vids["bad"], str(vids["dir"] / "ev_late"), assets={"logo": vids["logo"]}).check(item)
    assert r.passed and 4.5 <= r.evidence[0].t_start <= 5.5


def test_unknown_metric_is_not_measurable_not_failed_silently(vids):
    r = VideoChecker(vids["good"], str(vids["dir"] / "ev_x")).check({"id": "x", "text": "?", "kind": "check", "measure": {"metric": "smile_count", "op": ">=", "value": 1}})
    assert r.status == "not_measurable" and r.passed is False
