import os
os.environ.pop("OPENAI_API_KEY", None)
os.environ.pop("ANTHROPIC_API_KEY", None)

from fastapi.testclient import TestClient
from app.main import app, heuristic_question

client = TestClient(app)

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["documents"] >= 1

def test_demo_ask():
    r = client.post("/ask", json={"question": "Can it test IVR agents?", "provider": "demo", "answer_style": "short"})
    assert r.status_code == 200
    body = r.json()
    assert body["sources"]
    assert body["provider"] == "demo"
    assert body["answer"]

def test_question_detector():
    q = heuristic_question("We use a phone bot today. Can you test IVR and DTMF inputs?")
    assert q and "test" in q.lower()


def test_overlay_state():
    push = client.post('/overlay/push', json={
        'question': 'Does it support IVR?',
        'answer': 'Yes, according to the demo knowledge base.',
        'confidence': 0.91,
        'source': '01-agent-testing-product-guide.md'
    })
    assert push.status_code == 200
    state = client.get('/overlay/state')
    assert state.status_code == 200
    assert state.json()['visible'] is True
    assert state.json()['question'] == 'Does it support IVR?'
    hidden = client.post('/overlay/hide')
    assert hidden.status_code == 200
    assert hidden.json()['visible'] is False

def test_provider_status_exposes_local_transcription():
    r = client.get('/settings/providers')
    assert r.status_code == 200
    body = r.json()
    assert 'local_transcription' in body
    assert body['transcription_model'] in ('local', 'openai')
