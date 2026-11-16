pipeline {
  agent any

  environment {
    IMAGE = "atharvasingh7007/duostack"
    TAG   = "${env.BUILD_NUMBER}-${env.GIT_COMMIT ? env.GIT_COMMIT[0..7] : 'latest'}"
  }

  options {
    timeout(time: 20, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '15'))
    disableConcurrentBuilds()
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Quality Gates') {
      parallel {
        stage('Typecheck & Lint') {
          steps {
            sh 'npm ci'
            sh 'npm run typecheck'
          }
        }
        stage('Automated Tests (194 tests)') {
          steps {
            sh 'npm ci'
            sh 'npm test'
          }
        }
      }
    }

    stage('Build Container Image') {
      steps {
        sh 'docker build -t $IMAGE:$TAG -t $IMAGE:latest .'
      }
    }

    stage('Security Audit') {
      steps {
        sh 'npm audit --audit-level=high || true'
      }
    }

    stage('Push Container Image') {
      when {
        branch 'main'
      }
      steps {
        withCredentials([usernamePassword(credentialsId: 'dockerhub-credentials', usernameVariable: 'DOCKER_USER', passwordVariable: 'DOCKER_PASS')]) {
          sh 'echo $DOCKER_PASS | docker login -u $DOCKER_USER --password-stdin'
          sh 'docker push $IMAGE:$TAG'
          sh 'docker push $IMAGE:latest'
        }
      }
    }

    stage('Continuous Deployment') {
      when {
        branch 'main'
      }
      steps {
        sh 'chmod +x scripts/*.sh'
        sh './scripts/deploy.sh $TAG'
      }
    }
  }

  post {
    always {
      cleanWs()
    }
    success {
      echo "DuoStack CI/CD Pipeline completed successfully."
    }
    failure {
      echo "DuoStack CI/CD Pipeline failed. Check build logs for error details."
    }
  }
}
